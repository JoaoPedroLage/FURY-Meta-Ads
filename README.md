# FURY · Click Hero — Pipeline de Moderação de Anúncios

> Desafio Técnico — Full Stack Pleno  
> Desenvolvido para o projeto **FURY**, um gestor autônomo de tráfego pago movido a IA.

---

## Índice

1. [O que este projeto faz](#1-o-que-este-projeto-faz)
2. [Por que foi construído assim](#2-por-que-foi-construído-assim)
3. [Arquitetura e fluxo completo](#3-arquitetura-e-fluxo-completo)
4. [Estrutura de pastas explicada](#4-estrutura-de-pastas-explicada)
5. [Tecnologias utilizadas e por quê](#5-tecnologias-utilizadas-e-por-quê)
6. [Pré-requisitos](#6-pré-requisitos)
7. [Como rodar localmente](#7-como-rodar-localmente)
8. [Variáveis de ambiente](#8-variáveis-de-ambiente)
9. [Referência completa da API](#9-referência-completa-da-api)
10. [Lógica de retry e idempotência](#10-lógica-de-retry-e-idempotência)
11. [Testes rápidos via terminal](#11-testes-rápidos-via-terminal)
12. [Decisões técnicas e trade-offs](#12-decisões-técnicas-e-trade-offs)

---

## 1. O que este projeto faz

Imagine que o sistema de IA do FURY detecta que um anúncio está violando uma política da Meta (ex: uso de termo proibido). Nesse momento, uma notificação precisa ser recebida, validada e processada — removendo o anúncio da plataforma o mais rápido possível.

Este projeto implementa exatamente esse pipeline:

```
Meta / Sistema de IA
        │
        │  POST /webhook/violation
        ▼
┌─────────────────┐      válido      ┌──────────────────┐
│   API Express   │ ───────────────▶ │   Fila BullMQ    │
│  (validação Zod)│                  │   (Redis)        │
└─────────────────┘                  └──────────────────┘
        │                                     │
        │ inválido (400)               ┌──────▼───────┐
        ▼                              │    Worker    │
   Erro detalhado                      │  (processa   │
   por campo                           │   o takedown)│
                                       └──────────────┘
                                              │
                                    ┌─────────▼──────────┐
                                    │  Meta Ads API      │
                                    │  (JSONPlaceholder  │
                                    │   como substituto) │
                                    └────────────────────┘
```

**Em linguagem simples:** a API recebe o alerta, confere se os dados estão corretos, coloca o trabalho em uma fila para ser feito depois (de forma assíncrona), e um trabalhador em segundo plano executa a ação junto à Meta.

---

## 2. Por que foi construído assim

### Processamento assíncrono com fila

Se a API chamasse a Meta diretamente ao receber o webhook, qualquer lentidão ou falha da Meta derrubaria a resposta para o cliente. Com uma fila, a API responde imediatamente com `202 Accepted` ("recebemos, está sendo processado") e o trabalho pesado fica para o worker — **desacoplando recebimento de execução**.

### Retry automático com backoff exponencial

Redes falham. A Meta pode estar lenta. Em vez de perder o job para sempre, o worker tenta novamente — mas com pausa crescente entre tentativas (1s, 2s, 4s), para não sobrecarregar o servidor de destino.

### Idempotência

Se o mesmo webhook chegar duas vezes (falha de rede, retry do remetente), não queremos executar dois takedowns do mesmo anúncio. O sistema detecta duplicatas e rejeita com `409 Conflict`.

---

## 3. Arquitetura e fluxo completo

```
┌──────────────────────────────────────────────────────────────────────┐
│                          PROCESSO 1 — API                            │
│                                                                      │
│  POST /webhook/violation                                             │
│       │                                                              │
│       ├─▶ Zod valida o payload                                       │
│       │        └─ inválido → 400 + lista de erros por campo          │
│       │                                                              │
│       └─▶ enqueueTakedown()                                          │
│                │                                                     │
│                ├─▶ gera jobId = "adId:tenantId"                      │
│                ├─▶ verifica se já existe job ativo com esse ID       │
│                │        └─ existe → 409 Conflict                     │
│                └─▶ adiciona job na fila Redis → 202 Accepted         │
│                                                                      │
│  GET /jobs/:id                                                       │
│       └─▶ consulta BullMQ pelo jobId → retorna estado atual         │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        PROCESSO 2 — WORKER                           │
│                                                                      │
│  Aguarda jobs na fila                                                │
│       │                                                              │
│       └─▶ Recebe job → chama META_API_URL via HTTP                   │
│                │                                                     │
│                ├─▶ 2xx → job marcado como "completed" ✓              │
│                │                                                     │
│                ├─▶ 4xx → falha irrecuperável (UnrecoverableError)    │
│                │         job marcado como "failed" sem retry         │
│                │         (erro do cliente — retry não vai resolver)  │
│                │                                                     │
│                ├─▶ 5xx → falha recuperável → retry com backoff      │
│                │         tentativa 1: aguarda 1s                    │
│                │         tentativa 2: aguarda 2s                    │
│                │         tentativa 3: aguarda 4s                    │
│                │         esgotou → "failed"                         │
│                │                                                     │
│                └─▶ timeout → mesmo tratamento que 5xx               │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Estrutura de pastas explicada

```
click-hero/
│
├── src/
│   ├── index.ts                  # Ponto de entrada: inicia o servidor Express
│   │
│   ├── schemas/
│   │   └── violation.schema.ts   # Schema Zod: define e valida o formato do webhook
│   │
│   ├── queues/
│   │   ├── redis.ts              # Configuração da conexão com o Redis
│   │   ├── takedown.queue.ts     # Criação da fila BullMQ + lógica de idempotência
│   │   └── takedown.worker.ts    # Worker que processa os jobs e chama a Meta API
│   │
│   └── routes/
│       ├── webhook.ts            # Rota POST /webhook/violation
│       └── jobs.ts               # Rota GET /jobs/:id
│
├── .env                          # Variáveis de ambiente locais (NÃO vai ao git)
├── .env.example                  # Modelo de variáveis (vai ao git — sem valores sensíveis)
├── .gitignore                    # Arquivos ignorados pelo git
├── docker-compose.yml            # Sobe o Redis via Docker com um comando
├── package.json                  # Dependências e scripts do projeto
└── tsconfig.json                 # Configurações do TypeScript
```

---

## 5. Tecnologias utilizadas e por quê

| Tecnologia | Função no projeto | Por que foi escolhida |
|---|---|---|
| **Node.js + TypeScript** | Linguagem e runtime da API | TypeScript garante que erros de tipo sejam pegos antes de rodar — não em produção |
| **Express** | Servidor HTTP | Leve, amplamente conhecido, ideal para APIs simples e rápidas |
| **Zod** | Validação do payload do webhook | Valida E tipifica ao mesmo tempo — sem duplicação de código. Erros claros por campo |
| **BullMQ** | Sistema de filas de jobs | Filas confiáveis com retry, prioridade e monitoramento. Padrão de mercado com Redis |
| **Redis** | Banco de dados da fila | Ultra-rápido para operações de fila. BullMQ exige Redis como backend |
| **Axios** | Chamadas HTTP externas | Suporte nativo a timeout, interceptors e tratamento de erros HTTP estruturado |
| **Docker Compose** | Ambiente de desenvolvimento | Um comando sobe o Redis sem instalar nada na máquina |
| **dotenv** | Variáveis de ambiente | Mantém configurações sensíveis fora do código |

---

## 6. Pré-requisitos

Antes de rodar o projeto, você precisará ter instalado:

- **[Node.js 18 ou superior](https://nodejs.org/pt)** — o ambiente que executa o JavaScript/TypeScript
- **Uma das opções abaixo para o Redis:**
  - **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** — sobe o Redis em um container isolado com `docker compose up -d`
  - **[Upstash](https://upstash.com/)** (gratuito) — Redis na nuvem, sem precisar instalar nada localmente

> **O que é Redis?**  
> Redis é um banco de dados em memória extremamente rápido. O BullMQ usa o Redis como armazenamento das filas — cada job aguardando, sendo processado ou finalizado fica registrado lá.

---

## 7. Como rodar localmente

### Passo 1 — Baixar e instalar dependências

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/click-hero.git
cd click-hero

# Instale as dependências Node.js
npm install
```

### Passo 2 — Configurar variáveis de ambiente

```bash
# Copia o arquivo de exemplo
cp .env.example .env
```

O arquivo `.env` já vem com valores padrão que funcionam diretamente com o Docker. Só precisa editar se usar Upstash ou quiser mudar a porta.

### Passo 3 — Subir o Redis

**Com Docker (recomendado):**

> ⚠️ **Antes de rodar o comando abaixo**, certifique-se de que o **Docker Desktop está aberto e em execução**.
> Procure o ícone da baleia 🐳 na barra de tarefas — ele precisa estar estável (sem animação de carregamento).
> Se não estiver aberto, inicie o Docker Desktop pelo menu Iniciar e aguarde até ele ficar pronto.

```bash
docker compose up -d
```

> O Redis vai rodar em segundo plano na porta `6379`. Para verificar: `docker ps`

**Com Upstash (alternativa sem Docker):**

1. Crie uma conta gratuita em [upstash.com](https://upstash.com/)
2. Crie um banco Redis e copie a URL de conexão
3. No arquivo `.env`, substitua `REDIS_URL` pela URL do Upstash:
```
REDIS_URL=rediss://:sua-senha@seu-host.upstash.io:6380
```

### Passo 4 — Iniciar o servidor da API (terminal 1)

```bash
npm run dev
```

Você verá:
```
[server] Listening on http://localhost:3000
```

### Passo 5 — Iniciar o worker (terminal 2)

Abra um **segundo terminal** na mesma pasta e rode:

```bash
npm run worker
```

Você verá:
```
[worker] Listening on queue "takedown"...
```

> **Por que dois terminais?**  
> O servidor recebe as requisições HTTP. O worker processa os jobs da fila. São dois processos independentes — exatamente como funcionaria em produção (o worker poderia rodar em outra máquina/container).

---

## 8. Variáveis de ambiente

| Variável | Valor padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta onde o servidor HTTP vai escutar |
| `REDIS_URL` | `redis://localhost:6379` | Endereço de conexão com o Redis |
| `META_API_URL` | `https://jsonplaceholder.typicode.com/posts/1` | URL simulada da Meta API |
| `HTTP_TIMEOUT_MS` | `5000` | Tempo máximo de espera por resposta HTTP (em milissegundos) |

> **Sobre o `META_API_URL`:**  
> Em produção, apontaria para a API real da Meta. Para este desafio, usamos o [JSONPlaceholder](https://jsonplaceholder.typicode.com) — uma API pública de testes que sempre responde com sucesso. O objetivo é validar o fluxo completo (chamada HTTP, tratamento de erros, retry), não o conteúdo da resposta.

---

## 9. Referência completa da API

### `POST /webhook/violation`

**O que faz:** Recebe a notificação de um anúncio com violação, valida os dados e coloca na fila para remoção.

**URL:** `http://localhost:3000/webhook/violation`

**Corpo da requisição (JSON):**

```json
{
  "adId": "ad_abc123",
  "tenantId": "tenant_xyz",
  "violationType": "PROHIBITED_TERM",
  "severity": "HIGH",
  "detectedAt": "2024-03-15T10:30:00Z"
}
```

**Campos:**

| Campo | Tipo | Obrigatório | Valores aceitos |
|---|---|---|---|
| `adId` | texto | ✅ sim | qualquer string não vazia — identificador do anúncio |
| `tenantId` | texto | ✅ sim | qualquer string não vazia — identificador do cliente/conta |
| `violationType` | enum | ✅ sim | `PROHIBITED_TERM` (termo proibido) · `BRAND_VIOLATION` (violação de marca) · `COMPLIANCE_FAIL` (falha de conformidade) |
| `severity` | enum | ✅ sim | `LOW` · `MEDIUM` · `HIGH` · `CRITICAL` |
| `detectedAt` | datetime | ✅ sim | Data e hora no formato ISO 8601 — ex: `2024-03-15T10:30:00Z` |

**Respostas possíveis:**

| Código | Situação | Exemplo de resposta |
|---|---|---|
| `202 Accepted` | Job enfileirado com sucesso | `{ "jobId": "ad_abc123:tenant_xyz", "status": "queued" }` |
| `400 Bad Request` | Payload inválido ou incompleto | `{ "error": "Invalid payload", "details": { "violationType": ["Invalid enum value"] } }` |
| `409 Conflict` | Job duplicado — mesmo `adId + tenantId` já está ativo | `{ "error": "Duplicate job", "jobId": "ad_abc123:tenant_xyz", "message": "..." }` |
| `500 Internal Server Error` | Erro inesperado no servidor | `{ "error": "Failed to enqueue job" }` |

---

### `GET /jobs/:id`

**O que faz:** Consulta o estado atual de um job na fila pelo seu ID.

**URL:** `http://localhost:3000/jobs/{jobId}`

> O `jobId` é retornado no campo `jobId` da resposta do `POST /webhook/violation`. Ele sempre tem o formato `adId:tenantId`.

**Exemplo:**
```
GET http://localhost:3000/jobs/ad_abc123:tenant_xyz
```

**Resposta de sucesso (`200 OK`):**

```json
{
  "jobId": "ad_abc123:tenant_xyz",
  "status": "completed",
  "attempts": 1,
  "result": { "statusCode": 200 },
  "error": null
}
```

**Campos da resposta:**

| Campo | Descrição |
|---|---|
| `jobId` | Identificador único do job |
| `status` | Estado atual (veja tabela abaixo) |
| `attempts` | Quantas vezes o worker já tentou processar este job |
| `result` | Resultado quando bem-sucedido — contém o HTTP status code da Meta API |
| `error` | Mensagem de erro quando falhou — `null` caso contrário |

**Valores de `status`:**

| Status | Significado em português |
|---|---|
| `waiting` | Aguardando na fila — ainda não foi pego pelo worker |
| `active` | O worker está processando agora |
| `completed` | Processado com sucesso |
| `failed` | Falhou — todas as tentativas foram esgotadas |
| `delayed` | Aguardando o tempo de espera antes da próxima tentativa (backoff) |

**Resposta quando não encontrado (`404 Not Found`):**
```json
{ "error": "Job not found" }
```

---

### `GET /health`

**O que faz:** Verifica se a API está no ar (se está "saúdavel").

```json
{ "status": "ok" }
```

---

## 10. Lógica de retry e idempotência

### Retry com backoff exponencial

Quando o worker falha ao chamar a Meta API, ele não desiste imediatamente. O BullMQ agenda novas tentativas com intervalos crescentes:

```
Tentativa 1 → falha → aguarda 1 segundo
Tentativa 2 → falha → aguarda 2 segundos
Tentativa 3 → falha → job marcado como "failed"
```

Esse padrão é chamado de **backoff exponencial** — o tempo de espera dobra a cada tentativa. Isso evita sobrecarregar um servidor que já está com dificuldades.

### Falhas irrecuperáveis (4xx)

Se a Meta API responder com um erro **4xx** (ex: `400 Bad Request`, `403 Forbidden`), o worker entende que **o problema está nos dados enviados** — não faz sentido tentar de novo com os mesmos dados. Nesses casos, o job falha imediatamente sem consumir as tentativas restantes (`UnrecoverableError`).

| Tipo de erro | Comportamento |
|---|---|
| `2xx` (sucesso) | Job concluído ✓ |
| `4xx` (erro do cliente) | Falha imediata, sem retry |
| `5xx` (erro do servidor) | Retry com backoff exponencial |
| Timeout | Retry com backoff exponencial |

### Idempotência

O ID de cada job é gerado a partir de `adId + tenantId`:

```
jobId = "ad_abc123:tenant_xyz"
```

Se um webhook idêntico chegar enquanto um job com esse ID ainda está `waiting`, `active` ou `delayed`, a API retorna `409 Conflict` — **o mesmo takedown não será executado duas vezes**. Isso protege contra reenvios acidentais ou retries do remetente.

---

## 11. Testes rápidos via terminal

Você pode testar todos os cenários com `curl`. Se não tiver `curl`, use o [Postman](https://www.postman.com/) ou o [Insomnia](https://insomnia.rest/).

> ✅ Todos os comandos abaixo funcionam no **Windows** (CMD e PowerShell) e no **Unix/macOS** — copie e cole diretamente no terminal.

---

### Parte 1 — Fluxo principal (sucesso)

**Cenário 1 — Enviar um webhook válido** → Resposta esperada: `202 Accepted`

```
curl -s -X POST http://localhost:3000/webhook/violation -H "Content-Type: application/json" -d "{\"adId\":\"ad_001\",\"tenantId\":\"tenant_abc\",\"violationType\":\"PROHIBITED_TERM\",\"severity\":\"HIGH\",\"detectedAt\":\"2024-03-15T10:30:00Z\"}"
```

**Cenário 2 — Consultar o status do job criado acima** → Resposta esperada: `completed` ou `active`

```
curl -s http://localhost:3000/jobs/ad_001:tenant_abc
```

---

### Parte 2 — Cenários de erro

**Cenário 3 — Payload inválido** (campo `violationType` ausente) → Resposta esperada: `400 Bad Request` com lista de erros por campo

```
curl -s -X POST http://localhost:3000/webhook/violation -H "Content-Type: application/json" -d "{\"adId\":\"ad_001\",\"tenantId\":\"tenant_abc\",\"severity\":\"HIGH\",\"detectedAt\":\"2024-03-15T10:30:00Z\"}"
```

**Cenário 4 — Job duplicado** (rode logo após o Cenário 1, enquanto o job ainda está ativo) → Resposta esperada: `409 Conflict`

```
curl -s -X POST http://localhost:3000/webhook/violation -H "Content-Type: application/json" -d "{\"adId\":\"ad_001\",\"tenantId\":\"tenant_abc\",\"violationType\":\"PROHIBITED_TERM\",\"severity\":\"HIGH\",\"detectedAt\":\"2024-03-15T10:30:00Z\"}"
```

---

### Parte 3 — Health check

**Cenário 5 — Verificar se a API está no ar** → Resposta esperada: `{ "status": "ok" }`

```
curl -s http://localhost:3000/health
```

---

## 12. Decisões técnicas e trade-offs

### Por que dois processos separados (API + worker)?

Em produção, o servidor da API e o worker de processamento rodam em containers/máquinas separados. Isso permite:
- **Escalar independentemente** — se a fila crescer, sobe mais workers sem mexer na API
- **Isolamento de falhas** — se o worker travar, a API continua recebendo e enfileirando
- **Separação de responsabilidades** — o servidor só recebe; o worker só processa

### Por que Zod e não validação manual?

Validação manual (ifs encadeados) é verbosa, propensa a erros e não gera tipagem automática. O Zod valida e infere o tipo TypeScript ao mesmo tempo — uma única declaração de schema serve como contrato para toda a aplicação.

### Por que o jobId é `adId:tenantId`?

Esse formato garante que a mesma violação no mesmo cliente gere sempre o mesmo ID — tornando a operação naturalmente idempotente. O BullMQ permite especificar o ID do job, e IDs repetidos não criam duplicatas na fila.

### Por que `202 Accepted` e não `200 OK`?

O HTTP `202 Accepted` significa: *"recebemos sua requisição, mas o processamento ainda não foi concluído"*. É semanticamente mais correto que `200` para operações assíncronas — comunica ao cliente que ele deve consultar o status depois via `GET /jobs/:id`.

### Por que JSONPlaceholder como substituto da Meta API?

O desafio pede para simular a integração sem depender de credenciais reais da Meta. O JSONPlaceholder é uma API pública de testes que sempre retorna `200 OK`, permitindo validar o fluxo completo (chamada HTTP, tratamento de resposta, retry em caso de falha) de forma controlada.
