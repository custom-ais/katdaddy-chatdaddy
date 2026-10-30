import { getJobberAccessToken } from '@/lib/jobberTokens';
import { toJobberLocal } from './schedule';

const ENDPOINT = process.env.JOBBER_GRAPHQL_URL || 'https://api.getjobber.com/api/graphql';
const VERSION = process.env.JOBBER_GRAPHQL_VERSION || '2025-04-16';

export class JobberError extends Error {}

async function gql(query, variables = {}) {
  const token = await getJobberAccessToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': VERSION,
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors?.length) {
    const msg = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new JobberError(`Jobber API: ${msg}`);
  }
  return json.data;
}

function userErrors(result, op) {
  const errs = result?.userErrors || [];
  if (errs.length) throw new JobberError(`${op}: ${errs.map((e) => e.message).join('; ')}`);
}

const VISITS = `
  query BobVisits($after: ISO8601DateTime!, $before: ISO8601DateTime!, $cursor: String) {
    visits(first: 100, after: $cursor, filter: { startAt: { after: $after, before: $before } }) {
      pageInfo { hasNextPage endCursor }
      nodes { id startAt endAt allDay }
    }
  }
`;

// Every visit on the Jobber calendar between two instants.
export async function listVisits(from, to) {
  const visits = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const data = await gql(VISITS, { after: from.toISOString(), before: to.toISOString(), cursor });
    visits.push(...(data.visits?.nodes || []));
    if (!data.visits?.pageInfo?.hasNextPage) break;
    cursor = data.visits.pageInfo.endCursor;
  }
  return visits;
}

const SEARCH_CLIENTS = `
  query BobFindClient($searchTerm: String!) {
    clients(searchTerm: $searchTerm, first: 10) {
      nodes {
        id
        emails { address }
        phones { number }
        properties { id address { street1 postalCode } }
      }
    }
  }
`;

const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const street = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// An existing Jobber client with the same email or phone, so repeat customers aren't duplicated.
export async function findClient({ email, phone }) {
  for (const term of [email, digits(phone)].filter(Boolean)) {
    const data = await gql(SEARCH_CLIENTS, { searchTerm: term });
    const match = (data.clients?.nodes || []).find(
      (c) =>
        (email && c.emails?.some((e) => e.address?.toLowerCase() === email.toLowerCase())) ||
        (phone && c.phones?.some((p) => digits(p.number) === digits(phone)))
    );
    if (match) return match;
  }
  return null;
}

const CLIENT_CREATE = `
  mutation BobClientCreate($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client { id }
      userErrors { message path }
    }
  }
`;

function jobberAddress(a) {
  return { street1: a.street, city: a.city, province: 'AZ', postalCode: a.zip, country: 'US' };
}

export async function createClient(c) {
  const data = await gql(CLIENT_CREATE, {
    input: {
      firstName: c.firstName,
      lastName: c.lastName,
      emails: [{ description: 'MAIN', primary: true, address: c.email }],
      phones: [{ description: 'MAIN', primary: true, number: digits(c.phone) }],
      billingAddress: jobberAddress(c),
    },
  });
  userErrors(data.clientCreate, 'clientCreate');
  return data.clientCreate.client;
}

const PROPERTY_CREATE = `
  mutation BobPropertyCreate($clientId: EncodedId!, $input: PropertyCreateInput!) {
    propertyCreate(clientId: $clientId, input: $input) {
      properties { id }
      userErrors { message path }
    }
  }
`;

export async function findOrCreateProperty(client, c) {
  const existing = (client.properties || []).find(
    (p) => street(p.address?.street1) === street(c.street) && (!p.address?.postalCode || p.address.postalCode.startsWith(c.zip))
  );
  if (existing) return existing.id;
  const data = await gql(PROPERTY_CREATE, {
    clientId: client.id,
    input: { properties: [{ address: jobberAddress(c) }] },
  });
  userErrors(data.propertyCreate, 'propertyCreate');
  const id = data.propertyCreate.properties?.[0]?.id;
  if (!id) throw new JobberError('propertyCreate returned no property');
  return id;
}

const JOB_CREATE = `
  mutation BobJobCreate($input: JobCreateAttributes!) {
    jobCreate(input: $input) {
      job { id jobNumber }
      userErrors { message path }
    }
  }
`;

export async function createJob({ propertyId, title, instructions, lines }) {
  const data = await gql(JOB_CREATE, {
    input: {
      propertyId,
      title,
      instructions,
      lineItems: lines.map((l) => ({
        name: l.label,
        description: l.note || '',
        quantity: 1,
        unitPrice: l.amount,
        saveToProductsAndServices: false,
      })),
      invoicing: { invoicingType: 'FIXED_PRICE', invoicingSchedule: 'ON_COMPLETION' },
      scheduling: { createVisits: false, notifyTeam: false },
    },
  });
  userErrors(data.jobCreate, 'jobCreate');
  return data.jobCreate.job;
}

const VISIT_CREATE = `
  mutation BobVisitCreate($jobId: EncodedId!, $input: VisitCreateInput!) {
    visitCreate(jobId: $jobId, input: $input) {
      createdVisits { id startAt endAt }
      userErrors { message path }
    }
  }
`;

export async function createVisit(jobId, { title, instructions, start, end }) {
  const data = await gql(VISIT_CREATE, {
    jobId,
    input: {
      visits: [
        {
          title,
          instructions,
          schedule: { notifyTeam: false, startAt: toJobberLocal(start), endAt: toJobberLocal(end) },
        },
      ],
    },
  });
  userErrors(data.visitCreate, 'visitCreate');
  return data.visitCreate.createdVisits?.[0];
}
