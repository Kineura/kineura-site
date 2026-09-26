import { DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createHandler } from './handler.mjs';

const THROTTLE_WINDOW_MS = 10 * 60 * 1000;

const ddb = new DynamoDBClient({});
const ses = new SESv2Client({});

const LEADS_TABLE = process.env.LEADS_TABLE;
const THROTTLE_TABLE = process.env.THROTTLE_TABLE;

export const handler = createHandler({
  now: () => Date.now(),
  config: {
    rateLimit: Number(process.env.RATE_LIMIT ?? 5),
    ipSalt: process.env.IP_SALT ?? '',
  },

  putLead: async ({ fields, submittedAt, ipHash, sourceUrl, userAgent }) => {
    const item = {
      email: { S: fields.email },
      submittedAt: { S: submittedAt },
      name: { S: fields.name },
      formType: { S: fields.formType },
      status: { S: 'new' },
      ipHash: { S: ipHash },
    };
    if (fields.organization) item.organization = { S: fields.organization };
    if (fields.message) item.message = { S: fields.message };
    if (sourceUrl) item.sourceUrl = { S: sourceUrl };
    if (userAgent) item.userAgent = { S: userAgent };

    await ddb.send(new PutItemCommand({ TableName: LEADS_TABLE, Item: item }));
  },

  countPriorLeads: async (email) => {
    const out = await ddb.send(new QueryCommand({
      TableName: LEADS_TABLE,
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': { S: email } },
      Select: 'COUNT',
    }));
    return out.Count ?? 0;
  },

  // The window index is part of the key, so each 10-minute window is its own
  // row. TTL lag (which can reach 48h) then cannot keep a counter tripped.
  bumpThrottle: async (ipHash, nowMs) => {
    const window = Math.floor(nowMs / THROTTLE_WINDOW_MS);
    const expiresAt = Math.floor((window + 2) * THROTTLE_WINDOW_MS / 1000);
    const out = await ddb.send(new UpdateItemCommand({
      TableName: THROTTLE_TABLE,
      Key: { throttleKey: { S: `${ipHash}#${window}` } },
      UpdateExpression: 'ADD #c :one SET #e = if_not_exists(#e, :exp)',
      ExpressionAttributeNames: { '#c': 'count', '#e': 'expiresAt' },
      ExpressionAttributeValues: { ':one': { N: '1' }, ':exp': { N: String(expiresAt) } },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(out.Attributes?.count?.N ?? 1);
  },

  sendNotification: async ({ subject, body, replyTo }) => {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: process.env.SENDER_ADDRESS,
      Destination: { ToAddresses: [process.env.NOTIFY_EMAIL] },
      ReplyToAddresses: [replyTo],
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: body, Charset: 'UTF-8' } },
        },
      },
    }));
  },
});
