import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
if (process.env.NODE_ENV !== 'production') dotenv.config({ path: existsSync('.env') ? '.env' : '.env.local' });
const { default: app } = await import('./index.js');
const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`MatchSet API listening on :${port}`));
