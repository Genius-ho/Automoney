import { CoupangClient } from '../src/coupang-client.mjs';
import { loadCoupangConfig } from '../src/config.mjs';
import { createCoupangCategoryAdapter } from '../src/coupang-category-adapter.mjs';

const rootDir = process.cwd();
const displayCategoryCode = Number(process.argv[2]);
const coupangConfig = await loadCoupangConfig(rootDir);
const client = new CoupangClient(coupangConfig);
const adapter = createCoupangCategoryAdapter(client);
const meta = await adapter.getCategoryMeta(displayCategoryCode);
console.log('mandatoryOptionNames=', JSON.stringify(meta.mandatoryOptionNames));
console.log('attributes=', JSON.stringify(meta.attributes, null, 2));
const template = meta.noticeCategoryTemplates.find((t) => t.noticeCategoryName === '주방용품');
console.log('notice template detail names=', JSON.stringify(template?.noticeCategoryDetailNames, null, 2));
console.log('mandatoryCertificationNames=', JSON.stringify(meta.mandatoryCertificationNames));
