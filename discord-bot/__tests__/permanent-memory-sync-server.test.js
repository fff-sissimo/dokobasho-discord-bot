const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPermanentMemorySyncServer,
  buildPermanentMemoryMarkdown,
} = require('../src/permanent-memory-sync-server');

const postJson = async (url, body, headers = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text };
};

const getJson = async (url, headers = {}) => {
  const response = await fetch(url, {
    method: 'GET',
    headers,
  });
  const text = await response.text();
  return { status: response.status, text };
};

describe('permanent memory sync server', () => {
  it('builds markdown entry from sync payload', () => {
    const markdown = buildPermanentMemoryMarkdown({
      generated_at: '2026-02-24T12:34:56.000Z',
      source_workflow: 'daily_memory_prompt_merge',
      items: [
        {
          knowledge_id: 'K-20260224-0783a48d',
          knowledge_type: 'Decision',
          subject: 'member:390230419137626135',
          statement: '一次回答は常に公開する',
          confidence: 'high',
          tags: '意思決定,promote_permanent',
          short_memory_ids: 'SM-20260224-303432',
          source_message_links: 'https://discord.com/channels/1/2/3',
          source_candidate_id: 'KC-20260224-0783a48d',
        },
      ],
    });

    expect(markdown).toContain('## 2026-02-24T12:34:56.000Z');
    expect(markdown).toContain('K-20260224-0783a48d');
    expect(markdown).toContain('一次回答は常に公開する');
    expect(markdown).toContain('source_workflow: daily_memory_prompt_merge');
  });

  it('rejects unauthorized request', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permanent-sync-'));
    const server = await createPermanentMemorySyncServer({
      token: 'secret-token',
      outputDir: tmpDir,
      outputFile: 'permanent-memory.md',
      port: 0,
      path: '/internal/permanent-memory/sync',
    }).start();

    try {
      const url = `http://127.0.0.1:${server.port}/internal/permanent-memory/sync`;
      const response = await postJson(
        url,
        {
          generated_at: '2026-02-24T12:34:56.000Z',
          source_workflow: 'daily_memory_prompt_merge',
          items: [{ knowledge_id: 'K-1', statement: 'x' }],
        },
        { 'x-permanent-sync-token': 'wrong-token' }
      );

      expect(response.status).toBe(401);
      const outPath = path.join(tmpDir, 'permanent-memory.md');
      expect(fs.existsSync(outPath)).toBe(false);
    } finally {
      await server.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('appends markdown when request is valid', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permanent-sync-'));
    const server = await createPermanentMemorySyncServer({
      token: 'secret-token',
      outputDir: tmpDir,
      outputFile: 'permanent-memory.md',
      port: 0,
      path: '/internal/permanent-memory/sync',
    }).start();

    try {
      const url = `http://127.0.0.1:${server.port}/internal/permanent-memory/sync`;
      const response = await postJson(
        url,
        {
          generated_at: '2026-02-24T12:34:56.000Z',
          source_workflow: 'daily_memory_prompt_merge',
          items: [
            {
              knowledge_id: 'K-20260224-0783a48d',
              knowledge_type: 'Decision',
              subject: 'member:390230419137626135',
              statement: '一次回答は常に公開する',
              confidence: 'high',
              tags: '意思決定,promote_permanent',
              short_memory_ids: 'SM-20260224-303432',
              source_message_links: 'https://discord.com/channels/1/2/3',
              source_candidate_id: 'KC-20260224-0783a48d',
            },
          ],
        },
        { 'x-permanent-sync-token': 'secret-token' }
      );

      expect(response.status).toBe(202);

      const outPath = path.join(tmpDir, 'permanent-memory.md');
      expect(fs.existsSync(outPath)).toBe(true);
      const contents = fs.readFileSync(outPath, 'utf8');
      expect(contents).toContain('K-20260224-0783a48d');
      expect(contents).toContain('一次回答は常に公開する');
    } finally {
      await server.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed payload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permanent-sync-'));
    const server = await createPermanentMemorySyncServer({
      token: 'secret-token',
      outputDir: tmpDir,
      outputFile: 'permanent-memory.md',
      port: 0,
      path: '/internal/permanent-memory/sync',
    }).start();

    try {
      const url = `http://127.0.0.1:${server.port}/internal/permanent-memory/sync`;
      const response = await postJson(
        url,
        {
          generated_at: '2026-02-24T12:34:56.000Z',
          source_workflow: 'daily_memory_prompt_merge',
          items: [],
        },
        { 'x-permanent-sync-token': 'secret-token' }
      );

      expect(response.status).toBe(400);
      const outPath = path.join(tmpDir, 'permanent-memory.md');
      expect(fs.existsSync(outPath)).toBe(false);
    } finally {
      await server.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns markdown tail via read endpoint', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permanent-sync-'));
    const server = await createPermanentMemorySyncServer({
      token: 'secret-token',
      outputDir: tmpDir,
      outputFile: 'permanent-memory.md',
      port: 0,
      path: '/internal/permanent-memory/sync',
      readPath: '/internal/permanent-memory/read',
      maxReadChars: 2000,
    }).start();

    try {
      const syncUrl = `http://127.0.0.1:${server.port}/internal/permanent-memory/sync`;
      const writeResponse = await postJson(
        syncUrl,
        {
          generated_at: '2026-02-24T12:34:56.000Z',
          source_workflow: 'daily_memory_prompt_merge',
          items: [
            {
              knowledge_id: 'K-20260224-0783a48d',
              knowledge_type: 'Decision',
              subject: 'member:390230419137626135',
              statement: '一次回答は常に公開する',
            },
          ],
        },
        { 'x-permanent-sync-token': 'secret-token' }
      );
      expect(writeResponse.status).toBe(202);

      const readUrl = `http://127.0.0.1:${server.port}/internal/permanent-memory/read?tail_chars=80`;
      const readResponse = await getJson(readUrl, { 'x-permanent-sync-token': 'secret-token' });
      expect(readResponse.status).toBe(200);

      const parsed = JSON.parse(readResponse.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.exists).toBe(true);
      expect(parsed.returned_chars).toBeLessThanOrEqual(80);
      expect(parsed.total_chars).toBeGreaterThan(0);
      expect(parsed.content).toContain('一次回答は常に公開する');
    } finally {
      await server.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty content when markdown file does not exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permanent-sync-'));
    const server = await createPermanentMemorySyncServer({
      outputDir: tmpDir,
      outputFile: 'permanent-memory.md',
      port: 0,
      readPath: '/internal/permanent-memory/read',
    }).start();

    try {
      const readUrl = `http://127.0.0.1:${server.port}/internal/permanent-memory/read`;
      const readResponse = await getJson(readUrl);
      expect(readResponse.status).toBe(200);

      const parsed = JSON.parse(readResponse.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.exists).toBe(false);
      expect(parsed.content).toBe('');
      expect(parsed.total_chars).toBe(0);
    } finally {
      await server.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects unauthorized read request', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permanent-sync-'));
    const server = await createPermanentMemorySyncServer({
      token: 'secret-token',
      outputDir: tmpDir,
      outputFile: 'permanent-memory.md',
      port: 0,
      readPath: '/internal/permanent-memory/read',
    }).start();

    try {
      const readUrl = `http://127.0.0.1:${server.port}/internal/permanent-memory/read`;
      const readResponse = await getJson(readUrl);
      expect(readResponse.status).toBe(401);
    } finally {
      await server.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
