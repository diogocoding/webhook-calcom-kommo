// webhook-calcom-kommo.js
// Recebe o webhook "BOOKING_CREATED" do Cal.com, identifica o lead certo no Kommo
// (via ?metadata[kommo_lead_id]= no link enviado pelo bot) e:
//   1. Preenche campos personalizados do lead com data/hora e link da reunião
//   2. Move o lead para a etapa "Marcação de Reunião (Bot)" — NÃO a etapa
//      definitiva "Marcação de Reunião". Essa etapa (Bot) é uma sala de espera:
//      o responsável liga pra confirmar que o lead é qualificado de verdade antes
//      de avançá-lo manualmente (Leads Qualificados → Marcação de Reunião real).
//      Isso existe pra "Total de Agendados" no dashboard continuar significando
//      "reunião confirmada por humano", não "qualquer clique no link do Cal.com".
//   3. Aplica a tag "agendado_calcom" (cor de destaque configurada no Kommo),
//      só para diferenciar visualmente de leads agendados manualmente por um humano
//
// Quem manda a mensagem de confirmação de fato é um Salesbot pequeno e dedicado,
// disparado pelo gatilho nativo "Imediatamente quando lead passa para uma etapa de
// funil" (configurado para disparar ao entrar em "Marcação de Reunião (Bot)",
// não mais na etapa definitiva) — NÃO este script. Isso é necessário porque a API
// de Chats do Kommo não permite que um sistema externo injete mensagem direto no
// canal do WhatsApp já conectado; só o próprio Kommo (manualmente ou via Salesbot)
// pode enviar por esse canal.
//
// Descartado: gatilho "Agendamento criado" (só reage a agendamento feito pelo cliente
// através da Página de Agendamentos nativa, que é recurso exclusivo do plano Pro) e
// gatilho "tag adicionada" (também exclusivo do plano Pro). Mudança de etapa de funil
// é o único gatilho equivalente disponível no plano Avançado.
//
// Requer no .env:
//   KOMMO_SUBDOMAIN=seu-subdominio
//   KOMMO_TOKEN=seu-token-de-api
//   KOMMO_CAMPO_DATA_REUNIAO_ID=<id do campo personalizado de texto/data>
//   KOMMO_CAMPO_LINK_REUNIAO_ID=<id do campo personalizado de texto>
//   KOMMO_ETAPA_MARCACAO_REUNIAO_BOT_ID=<id numérico da etapa "Marcação de Reunião (Bot)">
//     (valor atual desta conta: 111036852 — NÃO é mais a etapa definitiva de
//     Marcação de Reunião; essa agora só recebe leads movidos manualmente,
//     depois da ligação de confirmação)
//   PORT=3000 (ou o que o Render definir)

require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_BASE = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4`;

const CAMPO_DATA_REUNIAO_ID = process.env.KOMMO_CAMPO_DATA_REUNIAO_ID;
const CAMPO_LINK_REUNIAO_ID = process.env.KOMMO_CAMPO_LINK_REUNIAO_ID;
// Etapa "Marcação de Reunião (Bot)" — sala de espera, não a definitiva.
// ID atual desta conta: 111036852.
const ETAPA_MARCACAO_REUNIAO_BOT_ID = process.env.KOMMO_ETAPA_MARCACAO_REUNIAO_BOT_ID;

// Proteção contra entregas duplicadas do mesmo agendamento (ex: se o Cal.com reenviar
// o webhook porque o servidor demorou a responder na primeira tentativa, já que o
// plano free do Render "dorme" com inatividade). Guarda os IDs de reserva já
// processados nesta execução do servidor — simples, mas resolve o caso comum.
// Obs: reinicia a cada redeploy/hibernação; para garantia total, seria necessário
// persistir isso em algum lugar externo (ex: um campo no próprio lead do Kommo).
const bookingsJaProcessados = new Set();

function kommoHeaders() {
  return {
    Authorization: `Bearer ${KOMMO_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// Campos personalizados do Kommo do tipo "Data" ou "Data e hora" exigem o valor
// como timestamp Unix (segundos desde 1970-01-01 UTC) — não como string ISO.
// Um timestamp Unix já representa um instante exato no tempo, então não precisa
// de nenhum cálculo manual de offset de fuso horário: o JS já entende isso.
function paraTimestampUnix(date) {
  return Math.floor(date.getTime() / 1000);
}

app.post('/webhooks/calcom-booking', async (req, res) => {
  try {
    const payload = req.body;

    if (payload.triggerEvent !== 'BOOKING_CREATED') {
      return res.status(200).send('evento ignorado (não é criação de reunião)');
    }

    const booking = payload.payload;

    // Confirmado via teste real em 30/08/2026: o Cal.com devolve o parâmetro
    // passado na URL (?metadata[kommo_lead_id]=999) exatamente neste caminho.
    const leadId = booking?.metadata?.kommo_lead_id;

    if (!leadId) {
      console.error('Webhook do Cal.com sem kommo_lead_id — não foi possível linkar ao lead.', booking);
      return res.status(200).send('sem lead id — verificar geração do link no bot');
    }

    const bookingId = booking?.bookingId || booking?.uid;
    if (bookingId && bookingsJaProcessados.has(bookingId)) {
      console.log(`Booking ${bookingId} já foi processado antes — ignorando entrega duplicada do webhook.`);
      return res.status(200).send('duplicata ignorada');
    }

    const inicio = new Date(booking.startTime);
    const dataFormatada = inicio.toLocaleString('pt-BR', {
      timeZone: 'America/Recife',
      dateStyle: 'short',
      timeStyle: 'short',
    });

    const linkReuniao = booking?.videoCallData?.url || '';
    const dataTimestamp = paraTimestampUnix(inicio);

    // Preenche os campos, move para Marcação de Reunião (Bot) — sala de espera,
    // não a etapa definitiva — e aplica a tag de origem. A mudança de etapa é o
    // que dispara o Salesbot de confirmação no Kommo. O avanço pra Marcação de
    // Reunião de verdade (e antes disso, Leads Qualificados) continua manual,
    // feito pelo responsável depois da ligação de confirmação.
    const kommoResponse = await fetch(`${KOMMO_BASE}/leads/${leadId}`, {
      method: 'PATCH',
      headers: kommoHeaders(),
      body: JSON.stringify({
        status_id: Number(ETAPA_MARCACAO_REUNIAO_BOT_ID),
        custom_fields_values: [
          {
            field_id: Number(CAMPO_DATA_REUNIAO_ID),
            values: [{ value: dataTimestamp }],
          },
          {
            field_id: Number(CAMPO_LINK_REUNIAO_ID),
            values: [{ value: linkReuniao }],
          },
        ],
        _embedded: {
          tags: [{ name: 'agendado_calcom' }],
        },
      }),
    });

    const kommoResponseBody = await kommoResponse.text();

    if (!kommoResponse.ok) {
      // Isso é o que faltava antes: se o Kommo recusar o pedido (token inválido,
      // ID de campo errado, status_id que não existe nesse funil, etc.), o fetch
      // NÃO lança erro sozinho — precisa checar o status manualmente, senão o
      // código segue como se tivesse dado certo.
      console.error(`Kommo recusou a atualização do lead ${leadId}. Status: ${kommoResponse.status}. Resposta: ${kommoResponseBody}`);
      return res.status(200).send('kommo recusou a atualização, ver logs');
    }

    if (bookingId) bookingsJaProcessados.add(bookingId);

    console.log(`Lead ${leadId}: movido para Marcação de Reunião (Bot), tag agendado_calcom aplicada, reunião em ${dataFormatada}. Aguardando ligação de confirmação.`);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Erro processando webhook do Cal.com:', err);
    res.status(200).send('erro tratado, ver logs'); // sempre 200 pro Cal.com não re-tentar
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Webhook Cal.com → Kommo rodando');
});
