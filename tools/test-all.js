'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
for (const file of ['check.js', ...fs.readdirSync(__dirname).filter(f => /^test-.*\.js$/.test(f) && f !== 'test-all.js').sort(), 'check-links.js', 'package-setup.js', 'verify-package.js']) {
    console.log('\n=== ' + file + ' ===');
    execFileSync(process.execPath, [path.join(__dirname, file)], { cwd: root, stdio: 'inherit' });
}
execFileSync(process.execPath, [path.join(__dirname, 'verify-package.js'), '--setup'], { cwd: root, stdio: 'inherit' });
execFileSync(process.env.PYTHON || 'python', ['-I', '-c', 'import sys,unittest; sys.path.insert(0,sys.argv[1]); result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.discover(sys.argv[1],pattern="test_*.py")); sys.exit(not result.wasSuccessful())', path.join(root, 'backend')], { cwd: root, stdio: 'inherit' });
