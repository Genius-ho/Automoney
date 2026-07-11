#!/usr/bin/env node
import { createAdminServer } from '../src/admin-server.mjs';

const port = Number(process.env.PORT || 3000);
const server = await createAdminServer();
server.listen(port, () => {
  console.log(`adminServer=http://127.0.0.1:${port}/admin`);
});
