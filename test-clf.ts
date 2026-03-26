import { classifyActivityBatch } from './src/lib/ai';
classifyActivityBatch([{ url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', domain: 'developer.mozilla.org', title: 'MDN Web Docs' }]).then(res => console.log('RESULT:', JSON.stringify(res, null, 2))).catch(console.error);
