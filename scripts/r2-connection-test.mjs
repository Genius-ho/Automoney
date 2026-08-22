import { loadR2Config } from '../src/config.mjs';
import { R2Client, maskR2Secret } from '../src/r2-client.mjs';

const root = process.cwd();
const TEST_KEY = 'test/connection-test.txt';

async function main() {
  const config = await loadR2Config(root);
  console.log(`accountId=${config.accountId} accessKeyId=${maskR2Secret(config.accessKeyId)} bucket=${config.bucket} publicBaseUrl=${config.publicBaseUrl} (secretAccessKey/서명은 출력하지 않음)`);

  const client = new R2Client(config);
  const body = Buffer.from(`automoney R2 connection test @ ${new Date().toISOString()}\n`);

  console.log(`\n=== 1. ${TEST_KEY} 업로드 ===`);
  const { publicUrl } = await client.putObject(TEST_KEY, body, 'text/plain');
  console.log(`  업로드 완료: ${publicUrl}`);

  console.log('\n=== 2. 공개 URL HTTP 상태 확인 ===');
  const response = await fetch(publicUrl);
  console.log(`  ${publicUrl} -> HTTP ${response.status}`);
  const ok = response.status === 200;

  console.log('\n=== 3. 테스트 파일 삭제 ===');
  await client.deleteObject(TEST_KEY);
  console.log(`  삭제 완료: ${TEST_KEY}`);

  const result = { connectionTestSucceeded: ok, publicUrl, httpStatus: response.status };
  console.log(`\n${JSON.stringify(result, null, 2)}`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('r2:connection-test failed:', error.message);
  process.exitCode = 1;
});
