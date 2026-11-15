# free-model-aggregator-01

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/WV629/free-model-aggregator-01/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/WV629/free-model-aggregator-01/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

One server that serves the OpenAI Chat Completions and Anthropic Messages APIs over ten free-tier model providers, routing each request to the best free model that can serve it and failing over when a provider refuses.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_PROMPT_FILE=prompt.txt node main.ts
```

`node main.ts --list` prints the catalog the server registers, without starting the server.

## How it routes

- Candidates are every free model meeting the request's requirements (tools, vision, JSON mode, minimum context), ordered by the brief's quality rating, best first.
- A JSON-mode request from an OpenAI client only goes to a wire that can carry `response_format` (OpenAI or Gemini); an Anthropic-wire provider would echo JSON mode absent.
- A provider's budget is never published, so the server learns it from refusals: a refused provider is retried once with the same model (a refusal sits on its call number, and the next number usually answers) before the request falls over, and a provider that has failed three calls in a row, or used its whole sealed budget cap, is left out of later requests. Requests are passed through untouched in the provider's own wire — system prompt, user text and images, tools, stop sequences, `max_tokens`, JSON mode — and answered back in the wire the client used, with the provider's text whole, its usage counts, and its stop reason mapped.
- No clock, no unseeded randomness: every choice is a function of the brief, the requests and the providers' answers, so a replay leaves the same state export.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wkn1wnrf&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>
