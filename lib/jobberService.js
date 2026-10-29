const JOBBER_GRAPHQL_ENDPOINT = 'https://api.getjobber.com/api/graphql';

/**
 * Helper to make authenticated GraphQL calls to Jobber
 */
async function queryJobber(query, variables, accessToken) {
    const res = await fetch(JOBBER_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'X-JOBBER-GRAPHQL-VERSION': '2024-02-15'
        },
        body: JSON.stringify({ query, variables })
    });

    const json = await res.json();
    if (json.errors) {
        throw new Error(`Jobber GraphQL Error: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
}

/**
 * 1. Create Client in Jobber
 */
export async function createJobberClient(customer, accessToken) {
    const nameParts = customer.name.trim().split(' ');
    const firstName = nameParts[0] || 'Valued';
    const lastName = nameParts.slice(1).join(' ') || 'Customer';

    const mutation = `
    mutation CreateClient($input: ClientInput!) {
      clientCreate(input: $input) {
        client {
          id
          first: firstName
          last: lastName
        }
        userErrors {
          message
          path
        }
      }
    }
  `;

    const variables = {
        input: {
            firstName,
            lastName,
            emails: [{ address: customer.email, primary: true }],
            phones: [{ number: customer.phone, primary: true }]
        }
    };

    const data = await queryJobber(mutation, variables, accessToken);
    return data.clientCreate.client;
}

/**
 * 2. Attach Property to Client
 */
export async function createJobberProperty(clientId, addressString, accessToken) {
    const mutation = `
    mutation CreateProperty($input: PropertyInput!) {
      propertyCreate(input: $input) {
        property {
          id
        }
        userErrors {
          message
        }
      }
    }
  `;

    const variables = {
        input: {
            clientId,
            propertyAddress: {
                street1: addressString,
                city: 'Surprise',
                province: 'AZ',
                country: 'US',
                postalCode: '85374'
            }
        }
    };

    const data = await queryJobber(mutation, variables, accessToken);
    return data.propertyCreate.property;
}

/**
 * 3. Schedule Job in Jobber
 */
export async function createJobberJob(booking, clientId, propertyId, accessToken) {
    const mutation = `
    mutation CreateJob($input: JobInput!) {
      jobCreate(input: $input) {
        job {
          id
          jobNumber
          title
        }
        userErrors {
          message
        }
      }
    }
  `;

    const variables = {
        input: {
            clientId,
            propertyId,
            title: `[Dryer Vent Squad] ${booking.package}`,
            instructions: `Special Notes: ${booking.notes || 'None'}. Price Quoted: ${booking.price}`,
            lineItems: [
                {
                    name: booking.package,
                    description: "Full Dryer Vent Exhaust System Restoration & Diagnostic",
                    unitPrice: parseFloat(booking.price.toString().replace(/[^0-9.]/g, '')),
                    quantity: 1
                }
            ]
        }
    };

    const data = await queryJobber(mutation, variables, accessToken);
    return data.jobCreate.job;
}

Part 5: Sync API Route(Bot to Jobber Pipeline)Create app / api / jobber / sync - booking / route.js: import { NextResponse } from 'next/server';
import { createJobberClient, createJobberProperty, createJobberJob } from '@/lib/jobberService';

export async function POST(request) {
    try {
        const booking = await request.json();

        // Fetch stored OAuth Access Token from Database
        const accessToken = process.env.JOBBER_TEMP_ACCESS_TOKEN;

        // Step A: Create Client
        const client = await createJobberClient(
            { name: booking.name, email: booking.email, phone: booking.phone },
            accessToken
        );

        // Step B: Create Property
        const property = await createJobberProperty(client.id, booking.address, accessToken);

        // Step C: Create Job
        const job = await createJobberJob(booking, client.id, property.id, accessToken);

        return NextResponse.json({
            success: true,
            jobberClientId: client.id,
            jobberJobId: job.id,
            jobNumber: job.jobNumber
        });

    } catch (error) {
        console.error('Jobber Sync Failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

Part 6: Webhook Sync Listener(Jobber $\rightarrow$ Dashboard)Create app / api / jobber / webhook / route.js to keep status indicators on your dispatch board updated in real - time when jobs change inside Jobber: import { NextResponse } from 'next/server';

export async function POST(request) {
    try {
        const payload = await request.json();
        const { event, topic, objectId } = payload;

        console.log(`Received Jobber Webhook: Event [${event}] on Topic [${topic}] ID [${objectId}]`);

        // Example logic for updating Neon DB / Dashboard:
        if (topic === 'JOB' && event === 'UPDATE') {
            // 1. Query Jobber API for updated job status
            // 2. Update local Neon Postgres record to match Jobber state
        }

        return NextResponse.json({ received: true }, { status: 200 });
    } catch (error) {
        console.error('Webhook Processing Error:', error);
        return NextResponse.json({ error: 'Webhook Handler Failed' }, { status: 500 });
    }
}

