# OpenAI Responses API structured output notes

- Use `POST /v1/responses`.
- Send bearer auth with `Authorization: Bearer <api key>`.
- Prefer Structured Outputs over JSON mode.
- For Responses API, configure JSON Schema output with `text.format`.
- Expected shape:

```json
{
  "text": {
    "format": {
      "type": "json_schema",
      "name": "dokobasho_image_intent",
      "strict": true,
      "schema": {}
    }
  }
}
```

Sources checked:
- https://platform.openai.com/docs/api-reference/responses/create
- https://platform.openai.com/docs/guides/structured-outputs
