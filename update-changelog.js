import fs from 'fs';

let content = fs.readFileSync('CHANGELOG.md', 'utf8');

const newEntry = `## [0.5.38] - 2026-03-16

### Fixed
- **Permission Race Condition**: Fix race condition when switching permission mode during confirmation dialog
  - User could press Ctrl+O to switch to 'plan' mode while confirmation dialog was pending
  - Added re-evaluation of permission mode after user confirms tool execution
  - Synced permission mode ref in GlobalShortcuts to keep it updated

---

`;

content = content.replace('## [0.5.37] - 2026-03-15', newEntry + '## [0.5.37] - 2026-03-15');
fs.writeFileSync('CHANGELOG.md', content);
console.log('Updated CHANGELOG.md');
