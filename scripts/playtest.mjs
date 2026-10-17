import { createPlaytestClient } from '../lib/playtest.mjs';
const [operation = 'status', ...words] = process.argv.slice(2);
const client = createPlaytestClient();
try {
  if (operation === 'status' && !words.length) console.log(JSON.stringify(await client.status(), null, 2));
  else {
    const input = { operation, ...(words.length ? { question: words.join(' ') } : {}) };
    const job = await client.submit(input); console.log(JSON.stringify(job));
    console.log(JSON.stringify(await client.wait(job), null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
