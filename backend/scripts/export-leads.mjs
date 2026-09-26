// Dumps every lead to CSV on stdout, so teammates get a file without an AWS login.
// Runs under the developer's own credentials -- the Lambda role has no Scan.
//   node scripts/export-leads.mjs > leads.csv
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';

const TABLE = process.env.LEADS_TABLE ?? 'kineura-leads';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const COLUMNS = [
  'submittedAt', 'email', 'name', 'organization',
  'formType', 'status', 'message', 'sourceUrl', 'importedFrom',
];

const csvCell = (value = '') => `"${String(value).replace(/"/g, '""')}"`;

const ddb = new DynamoDBClient({ region: REGION });
const rows = [];
let startKey;

do {
  const page = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: startKey }));
  for (const item of page.Items ?? []) {
    rows.push(Object.fromEntries(COLUMNS.map((c) => [c, item[c]?.S ?? ''])));
  }
  startKey = page.LastEvaluatedKey;
} while (startKey);

rows.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

process.stdout.write(`${COLUMNS.join(',')}\n`);
for (const row of rows) {
  process.stdout.write(`${COLUMNS.map((c) => csvCell(row[c])).join(',')}\n`);
}
