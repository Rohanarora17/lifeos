const fs = require('fs');
const { execSync } = require('child_process');

const files = execSync('find src -type f -name "*.ts" -o -name "*.tsx"').toString().split('\n').filter(Boolean);

let count = 0;
files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let original = content;
    
    // Daily format: new Date().toISOString().slice(0, 10) -> new Date(Date.now() + 19800000).toISOString().slice(0, 10)
    content = content.replace(/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/g, "new Date(Date.now() + 19800000).toISOString().slice(0, 10)");
    
    // Daily format: new Date().toISOString().split('T')[0] -> new Date(Date.now() + 19800000).toISOString().slice(0, 10)
    content = content.replace(/new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/g, "new Date(Date.now() + 19800000).toISOString().slice(0, 10)");

    // Offset dates: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    content = content.replace(/new Date\(Date\.now\(\)\s*-\s*([^)]+)\)\.toISOString\(\)\.slice\(0,\s*10\)/g, "new Date(Date.now() + 19800000 - $1).toISOString().slice(0, 10)");

    // Full ISO: new Date().toISOString() -> new Date(Date.now() + 19800000).toISOString()
    // but we only replace it if it's standalone (not chained with slice/split which we already replaced)
    content = content.replace(/new Date\(\)\.toISOString\(\)(?![\.])/g, "new Date(Date.now() + 19800000).toISOString()");

    if (content !== original) {
        fs.writeFileSync(file, content);
        count++;
    }
});
console.log(`Updated ${count} files with IST logic.`);
