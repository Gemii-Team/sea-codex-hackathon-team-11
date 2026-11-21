import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const contactIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function runAws(args, input, profile, region) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', [
      ...args, ...(profile ? ['--profile', profile] : []), '--region', region, '--no-cli-pager',
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 25_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else if (/NoSuchKey|\(404\)/.test(stderr)) resolve(null);
      else reject(new Error('S3 history request failed'));
    });
    child.stdin.end(input);
  });
}

function fromKey(prefix, key, startedAt) {
  const contactId = key.slice(prefix.length, -5);
  return key.endsWith('.json') && contactIdPattern.test(contactId) ? { contactId, startedAt } : null;
}

export function createHistoryStore({ bucket, directory, profile, region, prefix = 'v1/conversations/' }) {
  const aws = (args, input) => runAws(args, input, profile, region);
  const uri = (id) => `s3://${bucket}/${prefix}${id}.json`;
  const filename = (id) => {
    if (!contactIdPattern.test(id)) throw new Error('Invalid contact ID');
    return join(directory, id + '.json');
  };

  async function get(id) {
    if (!contactIdPattern.test(id)) return null;
    const content = bucket
      ? await aws(['s3', 'cp', uri(id), '-', '--only-show-errors'])
      : await readFile(filename(id), 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
    return content === null ? null : JSON.parse(content);
  }

  async function list() {
    if (bucket) {
      const output = await aws([
        's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--output', 'json',
        '--query', 'Contents[].{key:Key,at:LastModified}',
      ]);
      if (output === null) throw new Error('S3 history bucket was unavailable');
      return (JSON.parse(output) ?? []).map(({ key, at }) => fromKey(prefix, key, at)).filter(Boolean);
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(files.filter((file) => file.isFile()).map(async ({ name }) => {
      const entry = fromKey(prefix, prefix + name);
      if (!entry) return null;
      const record = await get(entry.contactId);
      if (!record) return null;
      const { mtime } = await stat(filename(entry.contactId));
      return {
        contactId: record.contactId,
        startedAt: record.startedAt ?? mtime.toISOString(),
        contactName: record.contactName,
      };
    }))).filter(Boolean);
  }

  async function save(record) {
    const content = JSON.stringify(record, null, 2) + '\n';
    if (bucket) {
      const result = await aws([
        's3', 'cp', '-', uri(record.contactId), '--content-type', 'application/json', '--only-show-errors',
      ], content);
      if (result === null) throw new Error('S3 history bucket was unavailable');
      return;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = filename(record.contactId);
    const draft = target + '.tmp';
    await writeFile(draft, content, { mode: 0o600 });
    await rename(draft, target);
  }

  return { get, list, save, kind: bucket ? 's3' : 'local' };
}
