const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { ServiceBusClient } = require('@azure/service-bus');
const { app } = require('@azure/functions');

function extractBlobUrl(requestBody, queryBlobUrl) {
  if (queryBlobUrl && String(queryBlobUrl).trim()) {
    return String(queryBlobUrl).trim();
  }

  if (!requestBody) {
    return undefined;
  }

  if (typeof requestBody === 'string') {
    return requestBody.trim() || undefined;
  }

  return requestBody.blobUrl || requestBody.url;
}

function parseClearMetadataFlag(requestBody, queryClearMetadata) {
  const rawValue = queryClearMetadata ?? requestBody?.clearMetadata;

  if (rawValue === undefined || rawValue === null) {
    return false;
  }

  if (typeof rawValue === 'boolean') {
    return rawValue;
  }

  if (typeof rawValue === 'number') {
    return rawValue === 1;
  }

  if (typeof rawValue === 'string') {
    const normalized = rawValue.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  return false;
}

function buildBlobCreatedEvent(blobUrl, blobProperties) {
  const blobUri = new URL(blobUrl);
  const pathSegments = blobUri.pathname.split('/').filter(Boolean);

  if (pathSegments.length < 2) {
    throw new Error(`Blob URL path is invalid: '${blobUri.pathname}'.`);
  }

  const containerName = pathSegments[0];
  const blobName = decodeURIComponent(pathSegments.slice(1).join('/'));

  return [{
    id: crypto.randomUUID(),
    eventType: 'Microsoft.Storage.BlobCreated',
    subject: `/blobServices/default/containers/${containerName}/blobs/${blobName}`,
    eventTime: new Date().toISOString(),
    data: {
      blobType: blobProperties?.blobType || 'BlockBlob',
      url: blobUrl,
      contentType: blobProperties?.contentType || 'application/octet-stream'
    },
    dataVersion: '2.0'
  }];
}

app.http('RequeueBlobCreatedHttp', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    let sender;
    let serviceBusClient;

    try {
      const storageConnectionString = process.env.BlobStorage;
      const serviceBusConnectionString = process.env.ServiceBusConnection;
      const topicName = process.env.SERVICE_BUS_TOPIC_NAME;
      const requestBody = await request.json().catch(() => undefined);
      const blobUrl = extractBlobUrl(requestBody, request.query.get('blobUrl'));
      const clearMetadata = parseClearMetadataFlag(requestBody, request.query.get('clearMetadata'));

      if (!blobUrl) {
        return {
          status: 400,
          jsonBody: {
            message: 'Missing blobUrl. Pass it in query string (?blobUrl=...) or request body ({ "blobUrl": "..." }).'
          }
        };
      }

      if (!storageConnectionString) {
        return {
          status: 500,
          jsonBody: { message: 'BlobStorage is not configured.' }
        };
      }

      if (!serviceBusConnectionString) {
        return {
          status: 500,
          jsonBody: { message: 'ServiceBusConnection is not configured.' }
        };
      }

      if (!topicName) {
        return {
          status: 500,
          jsonBody: { message: 'SERVICE_BUS_TOPIC_NAME is not configured.' }
        };
      }

      const blobUri = new URL(blobUrl);
      const pathSegments = blobUri.pathname.split('/').filter(Boolean);

      if (pathSegments.length < 2) {
        return {
          status: 400,
          jsonBody: { message: `Blob URL path is invalid: '${blobUri.pathname}'.` }
        };
      }

      const containerName = pathSegments[0];
      const blobName = decodeURIComponent(pathSegments.slice(1).join('/'));

      const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      if (!(await blobClient.exists())) {
        return {
          status: 404,
          jsonBody: { message: `Blob not found: ${blobUrl}` }
        };
      }

      const blobProperties = await blobClient.getProperties();
      if (clearMetadata) {
        const existingMetadata = blobProperties.metadata || {};
        const cleanedMetadata = Object.fromEntries(
          Object.entries(existingMetadata).filter(([key]) => {
            const normalized = key.toLowerCase();
            return normalized !== 'cosmosid' && normalized !== 'noingestionreason';
          })
        );

        await blobClient.setMetadata(cleanedMetadata);
        context.log(`Removed cosmosId/noIngestionReason metadata (if present) for '${blobName}'.`);
      } else {
        context.log(`Skipped metadata clear for '${blobName}' because clearMetadata is false.`);
      }

      const eventPayload = buildBlobCreatedEvent(blobUrl, blobProperties);

      serviceBusClient = new ServiceBusClient(serviceBusConnectionString);
      sender = serviceBusClient.createSender(topicName);
      await sender.sendMessages({
        body: eventPayload,
        contentType: 'application/json'
      });

      context.log(`Published BlobCreated event for '${blobName}' to topic '${topicName}'.`);

      return {
        status: 200,
        jsonBody: {
          message: clearMetadata
            ? 'Metadata cleared and event published to Service Bus topic.'
            : 'Event published to Service Bus topic. Metadata was not cleared.',
          blobUrl,
          clearMetadata,
          topicName,
          eventPayload
        }
      };
    } catch (error) {
      context.error('RequeueBlobCreatedHttp failed during processing.');
      context.error(`Error name: ${error?.name}`);
      context.error(`Error message: ${error?.message}`);

      return {
        status: 500,
        jsonBody: {
          message: 'Failed to clear metadata and publish event.',
          error: error?.message
        }
      };
    } finally {
      if (sender) {
        await sender.close();
      }

      if (serviceBusClient) {
        await serviceBusClient.close();
      }
    }
  }
});