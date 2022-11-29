import fs from 'fs';
import * as epilog from '@epilog/epilog';

const fol = fs.readFileSync((process.argv[2] || 0), 'utf-8');

console.log(epilog.grindem(JSON.parse(fol)));
