# webhook-calcom-kommo

Backend de integração entre Cal.com e Kommo CRM — Escritório Robson Menezes Advogados, Núcleo de Direito Bancário.

---

## O que este projeto faz

Quando um lead agenda uma reunião pelo link do Cal.com enviado pelo bot do WhatsApp, este backend:

1. Recebe o evento de agendamento do Cal.com.
2. Identifica qual lead do Kommo fez aquele agendamento.
3. Preenche a data/hora e o link da reunião nos campos do lead.
4. Move o lead para a etapa "Marcação de Reunião (Bot)" no funil.
5. Aplica a tag `agendado_calcom`.

A partir daí, um Salesbot nativo do Kommo (não este código) envia a mensagem de confirmação para o cliente no WhatsApp.

---

## Por que esse backend existe

O Cal.com e o Kommo não se conversam nativamente — não existe uma integração pronta entre os dois. Quando alguém agenda um horário no Cal.com, a única forma dele avisar qualquer sistema externo é disparando um webhook (uma requisição HTTP) para uma URL configurada. Sem algo escutando essa URL, o agendamento fica só dentro do Cal.com, e o Kommo nunca fica sabendo que ele aconteceu.

Isso obriga a existência de um pequeno servidor "tradutor" no meio do caminho, que:

- Recebe o webhook do Cal.com no formato que ele manda.
- Descobre a qual lead do Kommo aquele agendamento pertence — o Cal.com não sabe nada sobre Kommo, então essa ligação é feita através de um parâmetro (`kommo_lead_id`) embutido na própria URL do link que o bot manda para o cliente (`?metadata[kommo_lead_id]={{lead.id}}`). O Cal.com devolve esse mesmo parâmetro dentro do payload do webhook, e é assim que se sabe quem é quem.
- Converte o formato de data/hora — o Cal.com manda a data em um formato, e a API do Kommo exige outro (ISO 8601 com offset explícito de fuso, por exemplo `2026-08-31T13:20:00-03:00`); sem essa conversão, o Kommo recusa a atualização.
- Chama a API do Kommo para de fato atualizar o lead — preencher campos, mudar de etapa e aplicar tag.
- Evita duplicidade — o Cal.com pode reenviar o mesmo webhook mais de uma vez (por exemplo, se o servidor demorou para responder); o backend guarda o ID de cada agendamento já processado para não aplicar a mesma atualização duas vezes.

Uma alternativa nativa do Kommo (agendamento próprio + Página de Agendamentos pública) existe, mas é exclusiva do plano Pro — esta conta está no plano Avançado, então essa rota não está disponível, e o Cal.com com este backend é o caminho viável.

### Por que o backend não manda a mensagem de confirmação diretamente pelo WhatsApp

Seria mais simples se este código, depois de atualizar o lead, já mandasse a mensagem de confirmação ele mesmo. Mas a API de Chats do Kommo não permite que um sistema externo injete mensagens diretamente no canal de WhatsApp já conectado — só o próprio Kommo pode enviar por esse canal, seja manualmente ou por um Salesbot.

Por isso o desenho é em duas partes:
- Este backend cuida só dos dados (atualizar o lead).
- Um Salesbot pequeno e dedicado, chamado "Confirmação de Reunião", cuida do envio da mensagem, disparado automaticamente assim que o lead entra na etapa "Marcação de Reunião (Bot)" (efeito colateral da atualização que este backend faz).

---

## Como funciona, passo a passo

```
Cliente clica no botão "Agendar" no bot do WhatsApp
        |
        v
Bot manda link do Cal.com com ?metadata[kommo_lead_id]={{lead.id}}
        |
        v
Cliente escolhe horário no Cal.com
        |
        v
Cal.com dispara webhook "BOOKING_CREATED" para este backend
        |
        v
Este backend (webhook-calcom-kommo.js):
  1. Confirma que o evento é BOOKING_CREATED
  2. Extrai o kommo_lead_id do payload
  3. Verifica se esse agendamento já foi processado (evita duplicata)
  4. Converte a data para o formato que o Kommo exige
  5. Faz PATCH no lead via API do Kommo:
       - preenche campo de data da reunião
       - preenche campo de link da reunião
       - muda status_id para "Marcação de Reunião (Bot)"
       - aplica tag "agendado_calcom"
        |
        v
Kommo detecta a mudança de etapa e dispara o Salesbot
"Confirmação de Reunião" (configurado nativamente no Kommo,
fora deste código), que envia a mensagem de confirmação
com data/hora/link para o cliente no WhatsApp
        |
        v
Responsável liga para o lead para confirmar que é qualificado de verdade
        |
        v
Se qualificado: move manualmente Leads Qualificados -> Marcação de
Reunião (a etapa definitiva, que conta nas métricas do dashboard)
Se desqualificado: move para a etapa apropriada e cancela a reunião
diretamente no Cal.com
```

Note que a etapa "Marcação de Reunião (Bot)" é uma sala de espera — só depois da confirmação humana o lead avança para "Marcação de Reunião" de verdade. Isso existe para que as métricas do dashboard (Hub Comercial) continuem significando "reunião confirmada por um humano", e não "qualquer clique no link do Cal.com".

---

## Variáveis de ambiente

Crie um `.env` (local) ou configure diretamente nas variáveis de ambiente do serviço de hospedagem usado em produção:

```env
KOMMO_SUBDOMAIN=sua-conta
KOMMO_TOKEN=seu-token-de-api-do-kommo
KOMMO_CAMPO_DATA_REUNIAO_ID=4351279
KOMMO_CAMPO_LINK_REUNIAO_ID=4351281
KOMMO_ETAPA_MARCACAO_REUNIAO_BOT_ID=111036852
PORT=3000
```

| Variável | O que é |
|---|---|
| `KOMMO_SUBDOMAIN` | Subdomínio da conta Kommo em uso |
| `KOMMO_TOKEN` | Token de API do Kommo — trocar periodicamente, e sempre que houver suspeita de exposição |
| `KOMMO_CAMPO_DATA_REUNIAO_ID` | ID do campo personalizado de texto/data da reunião |
| `KOMMO_CAMPO_LINK_REUNIAO_ID` | ID do campo personalizado de link da reunião |
| `KOMMO_ETAPA_MARCACAO_REUNIAO_BOT_ID` | ID da etapa "Marcação de Reunião (Bot)" — não é a etapa definitiva |
| `PORT` | Porta do servidor (definida automaticamente pela maioria dos serviços de hospedagem em produção) |

---

## Instalação e execução local

```bash
git clone <url-deste-repositorio>
cd webhook-calcom-kommo
npm install
npm start
```

## Deploy

O deploy é automático a cada push na branch principal, via integração do serviço de hospedagem com este repositório Git. Caso o serviço de hospedagem utilize um plano gratuito com hibernação por inatividade, recomenda-se um serviço de ping externo (por exemplo, UptimeRobot) para manter o servidor ativo e evitar que o primeiro webhook depois de um período ocioso demore ou falhe por timeout.

---

## Configuração necessária no Cal.com

Em Configurações do evento -> Webhooks, apontar para:

```
https://<url-do-servico>/webhooks/calcom-booking
```

Gatilho: Reserva Criada (`BOOKING_CREATED`). Usar sempre a versão mais recente do payload — uma versão antiga já causou um bug real de formatação de dados.

---

## Limitações conhecidas

- Proteção contra duplicidade não é persistente: os IDs de agendamento já processados ficam guardados em memória (`Set`), e são perdidos a cada redeploy ou hibernação do servidor. Para uma garantia total contra reentregas duplicadas do Cal.com mesmo depois de reiniciar, seria necessário persistir essa lista externamente (por exemplo, um campo no próprio lead do Kommo, ou um banco de dados simples).
- O backend sempre responde `200 OK` ao Cal.com, mesmo em caso de erro interno (registrado nos logs) — isso é proposital, para evitar que o Cal.com fique reenviando o mesmo webhook indefinidamente.

---

## Licença

Uso interno — Robson Menezes Advogados.
