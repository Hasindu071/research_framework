# Dependency Change → Test Discovery: Complete Fix

## The Problem

For commits that change `package.json` and `yarn.lock` (e.g., shell-quote 1.8.2 → 1.8.4):

```
✅ Dependency changes detected
❌ Candidate tests: 0
❌ Tests generated: 0
```

## Root Causes

### Bug #1: Only Processing "added" Lines in package.json

The `extractChangedDependencies()` function skipped deleted lines:

```typescript
if (line.type !== "added") continue;  // ❌ Misses version changes
```

Version bumps appear as TWO lines in the diff:
- `-"shell-quote": "1.8.2"` (type: deleted)
- `+"shell-quote": "1.8.4"` (type: added)

### Bug #2: yarn.lock Completely Ignored

The CASE 2 dependency analysis only checked `package.json`:

```typescript
if (changedFile !== "package.json") continue;  // ❌ Skips yarn.lock
```

Real commits modify both files for version pinning.

## The Fixes

### Fix #1: Process Both Added AND Deleted Lines

**File:** `test-analyzer.ts`, lines 353-401

```typescript
for (const line of changedLines) {
  if (line.type !== "added" && line.type !== "deleted") {
    continue;  // ✅ Process both types
  }
  // Extract package name from both old and new versions
}
```

### Fix #2: Add yarn.lock Support

**File:** `test-analyzer.ts`

**Added new function (lines 402-443):**
```typescript
function extractChangedDependenciesFromYarnLock(changedLines) {
  // Handles yarn.lock format: "package-name@npm:version"
  const match = line.content.match(/^\s*["']([^"'@]+)@/);
  // Extracts: package-name
}
```

**Updated CASE 2 condition (line 1338):**
```typescript
if (changedFile !== "package.json" && changedFile !== "yarn.lock") {
  continue;  // ✅ Process BOTH files
}
```

**Updated extractor selection (lines 1342-1344):**
```typescript
const dependencies = changedFile === "yarn.lock"
  ? extractChangedDependenciesFromYarnLock(change.changedLines)
  : extractChangedDependencies(change.changedLines);
```

## Pipeline Flow (After Fix)

```
Commit: package.json + yarn.lock
         ↓
CASE 2: Dependency Analysis
  ├─ Process package.json
  │  ├─ extract "shell-quote"
  │  ├─ find files importing "shell-quote"
  │  └─ find tests for those files
  │
  └─ Process yarn.lock
     ├─ extract "shell-quote"
     ├─ find files importing "shell-quote"
     └─ find tests for those files
         ↓
Deduplicate via Map
         ↓
Candidate tests ✅
```

## What Now Works

- ✅ Version upgrades in package.json
- ✅ Version upgrades in yarn.lock
- ✅ Version downgrades
- ✅ New dependencies
- ✅ Removed dependencies
- ✅ Commits modifying both package.json AND yarn.lock
- ✅ Deduplication (no double-counting)

## Expected Output

```json
{
  "dependencyChanges": [
    {
      "package": "shell-quote",
      "changeType": "added",
      "to": "1.8.4",
      "source": "package.json"
    },
    {
      "package": "shell-quote",
      "changeType": "upgraded",
      "from": "1.8.2",
      "to": "1.8.4",
      "source": "yarn.lock"
    }
  ],
  "prioritization": {
    "candidateTests": [
      {
        "testFile": "src/utils/__tests__/shell.test.ts",
        "relationship": "dependency",
        "reason": "Test covers source file that imports dependency \"shell-quote\"",
        "confidence": 0.8
      }
    ]
  }
}
```
