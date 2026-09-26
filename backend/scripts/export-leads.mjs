// Dumps every lead to CSV on stdout, so teammates get a file without an AWS login.
// Runs under the developer's own credentials -- the Lambda role has no Scan.
// Shells out to the AWS CLI (already a hard requirement of deploy.sh) rather
// than the AWS SDK: this repo ships zero npm dependencies, and @aws-sdk/*
// packages live only inside the Lambda runtime, not on a developer's machine.
//   node scripts/export-leads.mjs > leads.csv
import { execFileSync } from 'node:child_process';

const TABLE = process.env.LEADS_TABLE ?? 'kineura-leads';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const PAGE_SIZE = 1000;
const COLUMNS = [
  'submittedAt', 'email', 'name', 'organization',
  'formType', 'status', 'message', 'sourceUrl', 'importedFrom',
];

const csvCell = (value = '') => `"${String(value).replace(/"/g, '""')}"`;

function fail(message) {
  console.error(`export-leads: ${message}`);
  process.exit(1);
}

function scanPage(startingToken) {
  const args = [
    'dynamodb', 'scan',
    '--table-name', TABLE,
    '--region', REGION,
    '--max-items', String(PAGE_SIZE),
    '--output', 'json',
  ];
  if (startingToken) {
    args.push('--starting-token', startingToken);
  }

  let stdout;
  try {
    stdout = execFileSync('aws', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err.stderr && err.stderr.toString().trim()) || err.message;
    fail(`"aws dynamodb scan" failed for table "${TABLE}" in region "${REGION}".\n${detail}`);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    fail('could not parse "aws dynamodb scan" output as JSON.');
  }
}

const rows = [];
let startingToken;

do {
  const page = scanPage(startingToken);
  for (const item of page.Items ?? []) {
    rows.push(Object.fromEntries(COLUMNS.map((c) => [c, item[c]?.S ?? ''])));
  }
  startingToken = page.NextToken;
} while (startingToken);

rows.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

process.stdout.write(`${COLUMNS.join(',')}\n`);
for (const row of rows) {
  process.stdout.write(`${COLUMNS.map((c) => csvCell(row[c])).join(',')}\n`);
}
