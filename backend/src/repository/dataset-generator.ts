import fs from "fs";
import path from "path";

// For Excel export support (optional)
// Users can install with: npm install exceljs
let XLSX: any;
try {
  XLSX = require("exceljs");
} catch {
  // Excel support is optional — CSV export will always work
}

/**
 * Research dataset row for CSV export.
 * Contains all metrics needed for analyzing test generation effectiveness.
 */
export interface ResearchDatasetRow {
  repository: string;
  commitHash: string;
  commitMessage: string;
  commitType: string; // feat, fix, refactor, etc.
  commitClassification: string; // feature_with_tests, feature_without_tests, mixed
  filesChanged: string;
  filesChangedCount: number;
  candidateTests: string;
  candidateTestsCount: number;
  prioritizedTests: string;
  prioritizedTestsCount: number;
  baselineTests: string;
  baselineTestsCount: number;
  gapsFound: string;
  gapsFoundCount: number;
  generatedTests: string;
  generatedTestsCount: number;
  existingTestsPassed: string;
  existingTestsPassedCount: number;
  existingTestsFailed: string;
  existingTestsFailedCount: number;
  generatedTestsPassed: string;
  generatedTestsPassedCount: number;
  generatedTestsFailed: string;
  generatedTestsFailedCount: number;
  baselineTime: number; // seconds
  prioritizedTime: number; // seconds
  generationTime: number; // seconds
}

/**
 * Extract commit type (feat, fix, refactor, etc.) from commit message.
 * Follows conventional commits format.
 */
function extractCommitType(message: string): string {
  const match = message.match(/^(feat|fix|docs|style|refactor|perf|test|chore|ci)(\(.+\))?:/);
  if (match && match[1]) {
    return match[1];
  }
  // Default to "other" if not conventional commit format
  return "other";
}

/**
 * Convert a commit analysis result to a research dataset row.
 */
export function convertCommitResultToDatasetRow(
  result: any,
  repositoryName: string
): ResearchDatasetRow {
  const analysis = result.analysis ?? {};
  const prioritization = result.prioritization ?? {};
  const gapAnalysis = result.gapAnalysis ?? {};
  const existingTestExecution = result.existingTestExecution ?? {};
  const generatedTestExecution = result.generatedTestExecution ?? {};
  const timing = result.timing ?? {};
  const commitClassification = result.commitClassification ?? {};

  // filesChanged can be either a number (count) or array (list). Handle both.
  const filesChangedArray = Array.isArray(analysis.filesChanged) ? analysis.filesChanged : [];
  const filesChangedList = filesChangedArray.length > 0 ? filesChangedArray.join(",") : "none";
  
  const candidateTestsList = (prioritization.candidateTests ?? []).toString() || "0";
  const prioritizedTestsList = (prioritization.prioritizedTests ?? [])
    .map((t: any) => t.testFile)
    .join(",") || "none";
  const baselineTestsList = (existingTestExecution.results ?? [])
    .map((r: any) => r.testFile)
    .join(",") || "none";

  const gapsFoundList = (gapAnalysis.results ?? [])
    .map((g: any) => g.targetSymbol)
    .join(",") || "none";

  const generatedTestsList = (generatedTestExecution.results ?? [])
    .map((r: any) => r.generatedTestName)
    .join(",") || "none";

  const existingTestsPassedList = (existingTestExecution.results ?? [])
    .filter((r: any) => r.status === "passed")
    .map((r: any) => r.testFile)
    .join(",") || "none";

  const existingTestsFailedList = (existingTestExecution.results ?? [])
    .filter((r: any) => r.status === "failed")
    .map((r: any) => r.testFile)
    .join(",") || "none";

  const generatedTestsPassedList = (generatedTestExecution.results ?? [])
    .filter((r: any) => r.status === "passed")
    .map((r: any) => r.generatedTestName)
    .join(",") || "none";

  const generatedTestsFailedList = (generatedTestExecution.results ?? [])
    .filter((r: any) => r.status === "failed")
    .map((r: any) => r.generatedTestName)
    .join(",") || "none";

  return {
    repository: repositoryName,
    commitHash: result.commit?.hash ?? "unknown",
    commitMessage: result.commit?.message ?? "unknown",
    commitType: extractCommitType(result.commit?.message ?? ""),
    commitClassification: commitClassification.classification ?? "unknown",
    filesChanged: filesChangedList,
    filesChangedCount: analysis.filesChanged ?? 0,
    candidateTests: candidateTestsList,
    candidateTestsCount: prioritization.candidateTests ?? 0,
    prioritizedTests: prioritizedTestsList,
    prioritizedTestsCount: prioritization.prioritizedTests?.length ?? 0,
    baselineTests: baselineTestsList,
    baselineTestsCount: existingTestExecution.summary?.executed ?? 0,
    gapsFound: gapsFoundList,
    gapsFoundCount: gapAnalysis.summary?.totalVerifiedGaps ?? 0,
    generatedTests: generatedTestsList,
    generatedTestsCount: generatedTestExecution.summary?.generated ?? 0,
    existingTestsPassed: existingTestsPassedList,
    existingTestsPassedCount: existingTestExecution.summary?.passed ?? 0,
    existingTestsFailed: existingTestsFailedList,
    existingTestsFailedCount: existingTestExecution.summary?.failed ?? 0,
    generatedTestsPassed: generatedTestsPassedList,
    generatedTestsPassedCount: generatedTestExecution.summary?.passed ?? 0,
    generatedTestsFailed: generatedTestsFailedList,
    generatedTestsFailedCount: generatedTestExecution.summary?.failed ?? 0,
    baselineTime: timing.baselineTime ?? 0,
    prioritizedTime: timing.prioritizedTime ?? 0,
    generationTime: timing.generationTime ?? 0,
  };
}

/**
 * Generate RFC 4180 compliant CSV from dataset rows.
 */
export function generateCSV(rows: ResearchDatasetRow[]): string {
  if (rows.length === 0) {
    return "";
  }

  // Header row
  const headers: (keyof ResearchDatasetRow)[] = [
    "repository",
    "commitHash",
    "commitMessage",
    "commitType",
    "commitClassification",
    "filesChanged",
    "filesChangedCount",
    "candidateTests",
    "candidateTestsCount",
    "prioritizedTests",
    "prioritizedTestsCount",
    "baselineTests",
    "baselineTestsCount",
    "gapsFound",
    "gapsFoundCount",
    "generatedTests",
    "generatedTestsCount",
    "existingTestsPassed",
    "existingTestsPassedCount",
    "existingTestsFailed",
    "existingTestsFailedCount",
    "generatedTestsPassed",
    "generatedTestsPassedCount",
    "generatedTestsFailed",
    "generatedTestsFailedCount",
    "baselineTime",
    "prioritizedTime",
    "generationTime",
  ];

  /**
   * Escape CSV field value according to RFC 4180.
   * If the field contains quotes, commas, or newlines, wrap it in quotes
   * and escape any internal quotes by doubling them.
   */
  function escapeCSVField(value: any): string {
    const str = String(value ?? "");
    if (str.includes('"') || str.includes(",") || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const lines: string[] = [];

  // Header
  lines.push(headers.map(escapeCSVField).join(","));

  // Data rows
  for (const row of rows) {
    const values = headers.map((header) => row[header]);
    lines.push(values.map(escapeCSVField).join(","));
  }

  return lines.join("\n");
}

/**
 * Save dataset to a CSV file.
 */
export async function saveDataset(rows: ResearchDatasetRow[], outputPath: string): Promise<void> {
  const csv = generateCSV(rows);

  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file
  fs.writeFileSync(outputPath, csv, "utf-8");
  console.log(`[Dataset] Saved ${rows.length} rows to ${outputPath}`);
}

/**
 * Load existing dataset from CSV file.
 */
export function loadDataset(filePath: string): ResearchDatasetRow[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return [];
  }

  const headers = (lines[0] ?? "").split(",");
  const rows: ResearchDatasetRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const values = parseCSVLine(line);
    if (values.length !== headers.length) {
      continue; // Skip malformed lines
    }

    const row: any = {};
    for (let j = 0; j < headers.length; j++) {
      const header = (headers[j] ?? "").trim();
      const value = values[j] ?? ""; // Default to empty string if undefined
      row[header] = value;
    }

    rows.push(row as ResearchDatasetRow);
  }

  return rows;
}

/**
 * Parse a CSV line, handling quoted fields and escaped quotes.
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      // Field separator
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  // Add last field
  fields.push(current.trim());

  return fields;
}

/**
 * Save dataset to an Excel file (.xlsx).
 * Requires exceljs to be installed: npm install exceljs
 */
export async function saveDatasetAsExcel(rows: ResearchDatasetRow[], outputPath: string): Promise<void> {
  if (!XLSX) {
    throw new Error(
      "exceljs is not installed. Install it with: npm install exceljs\n" +
      "Or use saveDataset() for CSV export instead."
    );
  }

  const workbook = new XLSX.Workbook();
  const worksheet = workbook.addWorksheet("Research Data");

  // Define headers
  const headers: (keyof ResearchDatasetRow)[] = [
    "repository",
    "commitHash",
    "commitMessage",
    "commitType",
    "commitClassification",
    "filesChanged",
    "filesChangedCount",
    "candidateTests",
    "candidateTestsCount",
    "prioritizedTests",
    "prioritizedTestsCount",
    "baselineTests",
    "baselineTestsCount",
    "gapsFound",
    "gapsFoundCount",
    "generatedTests",
    "generatedTestsCount",
    "existingTestsPassed",
    "existingTestsPassedCount",
    "existingTestsFailed",
    "existingTestsFailedCount",
    "generatedTestsPassed",
    "generatedTestsPassedCount",
    "generatedTestsFailed",
    "generatedTestsFailedCount",
    "baselineTime",
    "prioritizedTime",
    "generationTime",
  ];

  // Add header row with formatting
  const headerRow = worksheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF366092" } };
  headerRow.alignment = { horizontal: "center", vertical: "center" };

  // Add data rows
  for (const row of rows) {
    const values = headers.map((header) => row[header]);
    const dataRow = worksheet.addRow(values);
    
    // Alternate row colors for readability
    if (rows.indexOf(row) % 2 === 0) {
      dataRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    }
  }

  // Adjust column widths
  for (let i = 0; i < headers.length; i++) {
    const column = worksheet.columns[i];
    if (column) {
      column.width = 15;
    }
  }

  // Freeze header row
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  // Ensure directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file
  await workbook.xlsx.writeFile(outputPath);
  console.log(`[Dataset] Saved ${rows.length} rows to Excel file: ${outputPath}`);
}

/**
 * Export dataset in both CSV and Excel formats.
 * Excel export is optional (only if exceljs is installed).
 */
export async function exportDataset(
  rows: ResearchDatasetRow[],
  outputDir: string,
  baseName: string = "research-dataset"
): Promise<{ csv: string; excel: string | undefined }> {
  const csvPath = path.join(outputDir, `${baseName}.csv`);
  const excelPath = path.join(outputDir, `${baseName}.xlsx`);

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Always save CSV
  await saveDataset(rows, csvPath);

  // Try to save Excel (optional)
  let excelResult: string | undefined;
  try {
    if (XLSX) {
      await saveDatasetAsExcel(rows, excelPath);
      excelResult = excelPath;
    } else {
      console.log(
        "[Dataset] ℹ️ Excel export skipped (exceljs not installed). " +
        "Install with: npm install exceljs"
      );
    }
  } catch (error) {
    console.warn(
      `[Dataset] ⚠️ Excel export failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return { csv: csvPath, excel: excelResult };
}

/**
 * Generate summary statistics from dataset rows.
 */
export function getDatasetSummary(rows: ResearchDatasetRow[]): Record<string, any> {
  if (rows.length === 0) {
    return { totalRows: 0, commits: 0 };
  }

  const repositories = new Set(rows.map((r) => r.repository)).size;
  const commits = new Set(rows.map((r) => r.commitHash)).size;

  const classifications = {
    feature_with_tests: 0,
    feature_without_tests: 0,
    mixed: 0,
    unknown: 0,
  };

  let totalGapsFound = 0;
  let totalGeneratedTests = 0;
  let totalGeneratedPassed = 0;
  let totalGeneratedFailed = 0;
  let totalBaselinePassed = 0;
  let totalBaselineFailed = 0;
  let totalTimeSeconds = 0;

  for (const row of rows) {
    const cls = row.commitClassification as keyof typeof classifications;
    if (cls in classifications) {
      classifications[cls]++;
    } else {
      classifications.unknown++;
    }

    totalGapsFound += row.gapsFoundCount;
    totalGeneratedTests += row.generatedTestsCount;
    totalGeneratedPassed += row.generatedTestsPassedCount;
    totalGeneratedFailed += row.generatedTestsFailedCount;
    totalBaselinePassed += row.existingTestsPassedCount;
    totalBaselineFailed += row.existingTestsFailedCount;
    totalTimeSeconds += row.baselineTime + row.prioritizedTime + row.generationTime;
  }

  const generatedPassRate =
    totalGeneratedTests > 0
      ? ((totalGeneratedPassed / totalGeneratedTests) * 100).toFixed(2)
      : "N/A";

  const baselinePassRate =
    totalBaselinePassed + totalBaselineFailed > 0
      ? (
          ((totalBaselinePassed / (totalBaselinePassed + totalBaselineFailed)) * 100).toFixed(2)
        )
      : "N/A";

  return {
    totalRows: rows.length,
    repositories,
    commits,
    classifications,
    gaps: {
      total: totalGapsFound,
      averagePerCommit: (totalGapsFound / rows.length).toFixed(2),
    },
    generated: {
      total: totalGeneratedTests,
      passed: totalGeneratedPassed,
      failed: totalGeneratedFailed,
      passRate: generatedPassRate,
    },
    baseline: {
      passed: totalBaselinePassed,
      failed: totalBaselineFailed,
      passRate: baselinePassRate,
    },
    timing: {
      totalSeconds: totalTimeSeconds.toFixed(2),
      averageSecondsPerCommit: (totalTimeSeconds / rows.length).toFixed(2),
    },
  };
}

/**
 * Print a formatted summary report to console.
 */
export function printDatasetSummary(rows: ResearchDatasetRow[]): void {
  const summary = getDatasetSummary(rows);

  console.log("\n========================================");
  console.log("RESEARCH DATASET SUMMARY");
  console.log("========================================\n");

  console.log(`📊 Dataset Size:`);
  console.log(`   Rows: ${summary.totalRows}`);
  console.log(`   Repositories: ${summary.repositories}`);
  console.log(`   Commits: ${summary.commits}\n`);

  console.log(`📋 Commit Classifications:`);
  console.log(`   With Tests: ${summary.classifications.feature_with_tests}`);
  console.log(`   Without Tests: ${summary.classifications.feature_without_tests}`);
  console.log(`   Mixed: ${summary.classifications.mixed}`);
  console.log(`   Unknown: ${summary.classifications.unknown}\n`);

  console.log(`🔍 Coverage Gaps:`);
  console.log(`   Total: ${summary.gaps.total}`);
  console.log(`   Average per Commit: ${summary.gaps.averagePerCommit}\n`);

  console.log(`✅ Generated Tests:`);
  console.log(`   Total: ${summary.generated.total}`);
  console.log(`   Passed: ${summary.generated.passed}`);
  console.log(`   Failed: ${summary.generated.failed}`);
  console.log(`   Pass Rate: ${summary.generated.passRate}%\n`);

  console.log(`📈 Baseline Tests:`);
  console.log(`   Passed: ${summary.baseline.passed}`);
  console.log(`   Failed: ${summary.baseline.failed}`);
  console.log(`   Pass Rate: ${summary.baseline.passRate}%\n`);

  console.log(`⏱️  Timing:`);
  console.log(`   Total: ${summary.timing.totalSeconds}s`);
  console.log(`   Average per Commit: ${summary.timing.averageSecondsPerCommit}s\n`);

  console.log("========================================\n");
}
