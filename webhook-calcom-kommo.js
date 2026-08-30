// webhook-calcom-kommo.js
// Recebe o webhook "BOOKING_CREATED" do Cal.com, identifica o lead certo no Kommo
// (via ?metadata[kommo_lead_id]= no link enviado pelo bot) e:
//   1. Preenche campos personalizados do lead com data/hora e link da reunião
//   2. Move o lead para a etapa "Marcação de Reunião"
//   3. Aplica a tag "agendado_calcom" (cor de destaque configurada no Kommo),
//      só para diferenciar visualmente de leads agendados manualmente por um humano
//
// Quem manda a mensagem de confirmação de fato é um Salesbot pequeno e dedicado,
// disparado pelo gatilho nativo "Imediatamente quando lead passa para uma etapa de
// funil" — NÃO este script. Isso é necessário porque a API de Chats do Kommo não
// permite que um sistema externo injete mensagem direto no canal do WhatsApp já
// conectado; só o próprio Kommo (manualmente ou via Salesbot) pode enviar por esse canal.
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
//   KOMMO_ETAPA_MARCACAO_REUNIAO_ID=<id numérico da etapa "Marcação de Reunião" no funil>
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
const ETAPA_MARCACAO_REUNIAO_ID = process.env.KOMMO_ETAPA_MARCACAO_REUNIAO_ID;

function kommoHeaders() {
  return {
    Authorization: `Bearer ${KOMMO_TOKEN}`,
    'Content-Type': 'application/json',
  };
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

    const inicio = new Date(booking.startTime);
    const dataFormatada = inicio.toLocaleString('pt-BR', {
      timeZone: 'America/Recife',
      dateStyle: 'short',
      timeStyle: 'short',
    });

    const linkReuniao = booking?.videoCallData?.url || '';

    // Preenche os campos, move para Marcação de Reunião e aplica a tag de origem.
    // A mudança de etapa é o que dispara o Salesbot de confirmação no Kommo.
    await fetch(`${KOMMO_BASE}/leads/${leadId}`, {
      method: 'PATCH',
      headers: kommoHeaders(),
      body: JSON.stringify({
        status_id: Number(ETAPA_MARCACAO_REUNIAO_ID),
        custom_fields_values: [
          {
            field_id: Number(CAMPO_DATA_REUNIAO_ID),
            values: [{ value: dataFormatada }],
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

    console.log(`Lead ${leadId}: movido para Marcação de Reunião, tag agendado_calcom aplicada, reunião em ${dataFormatada}.`);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Erro processando webhook do Cal.com:', err);
    res.status(200).send('erro tratado, ver logs'); // sempre 200 pro Cal.com não re-tentar
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Webhook Cal.com → Kommo rodando');
});