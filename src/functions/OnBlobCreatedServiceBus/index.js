const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { app } = require('@azure/functions');

function normalizeServiceBusMessage(message) {
  if (Buffer.isBuffer(message)) {
    const raw = message.toString('utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  if (typeof message === 'string') {
    try {
      return JSON.parse(message);
    } catch {
      return message;
    }
  }

  return message;
}

function getEventFromMessage(message, context) {
  const normalized = normalizeServiceBusMessage(message);

  if (Array.isArray(normalized)) {
    if (normalized.length === 0) {
      return undefined;
    }

    if (normalized.length > 1) {
      context.log(`Service Bus message contained ${normalized.length} events. Processing the first event only.`);
    }

    return normalized[0];
  }

  return normalized;
}

app.serviceBusTopic('OnBlobCreatedServiceBus', {
  connection: 'ServiceBusConnection',
  topicName: process.env.SERVICE_BUS_TOPIC_NAME,
  subscriptionName: process.env.SERVICE_BUS_SUBSCRIPTION_NAME,
  handler: async (message, context) => {
    try {
      const targetContainer = 'landingsb';
      const storageConnectionString = process.env.BlobStorage;
      const event = getEventFromMessage(message, context);
      const eventType = event?.eventType || event?.type;
      const blobUrl = event?.data?.url || event?.data?.blobUrl;

      context.log('Service Bus trigger fired!');
      context.log(`Event Type: ${eventType}`);
      context.log(`Event Id: ${event?.id}`);
      context.log(`Event Subject: ${event?.subject}`);
      context.log(`Blob URL: ${blobUrl}`);

      if (eventType === 'Microsoft.Storage.BlobDeleted') {
        context.log('Ignoring BlobDeleted event.');
        return;
      }

      if (eventType !== 'Microsoft.Storage.BlobCreated') {
        context.log(`Ignoring event type '${eventType}'.`);
        return;
      }

      if (!blobUrl) {
        context.log('Event did not include a blob URL. Skipping metadata update.');
        return;
      }

      if (!storageConnectionString) {
        context.log('BlobStorage is not configured. Skipping metadata update.');
        return;
      }

      const blobUri = new URL(blobUrl);
      const pathSegments = blobUri.pathname.split('/').filter(Boolean);

      if (pathSegments.length < 2) {
        context.log(`Blob URL path is invalid: '${blobUri.pathname}'.`);
        return;
      }

      const containerName = pathSegments[0];
      const blobName = decodeURIComponent(pathSegments.slice(1).join('/'));

      if (containerName.toLowerCase() !== targetContainer) {
        context.log(`Ignoring blob in container '${containerName}'. Expected '${targetContainer}'.`);
        return;
      }

      const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      const blobProperties = await blobClient.getProperties();
      const existingMetadata = blobProperties.metadata || {};
      const existingCosmosId = existingMetadata.cosmosId || existingMetadata.cosmosid;
      const existingNoIngestionReason = existingMetadata.noingestionreason || existingMetadata.noIngestionReason;

      if (existingCosmosId) {
        context.log(`cosmosId was already present for blob '${blobName}' with value '${existingCosmosId}'. Exiting without update.`);
        return;
      }

      if (existingNoIngestionReason) {
        context.log(`noIngestionReason was already present for blob '${blobName}' with value '${existingNoIngestionReason}'. Exiting without update.`);
        return;
      }

      const noIngestionReason = "Blob name starts with 'ignore', so skipping ingestion.";
      if (blobName.toLowerCase().startsWith('ignore')) {
        await blobClient.setMetadata({
          ...existingMetadata,
          noIngestionReason
        });
        context.log(`noIngestionReason metadata set for blob '${blobName}': ${noIngestionReason}`);
        return;
      }

      const cosmosId = crypto.randomUUID();
      await blobClient.setMetadata({
        ...existingMetadata,
        cosmosId
      });

      context.log(`cosmosId metadata set for blob '${blobName}': ${cosmosId}`);
    } catch (error) {
      context.error('OnBlobCreatedServiceBus failed during processing.');
      context.error(`Error name: ${error?.name}`);
      context.error(`Error message: ${error?.message}`);
      context.error(`Status code: ${error?.statusCode}`);
      context.error(`Error code: ${error?.code}`);

      if (error?.details?.errorCode) {
        context.error(`Service error code: ${error.details.errorCode}`);
      }

      if (error?.details?.message) {
        context.error(`Service message: ${error.details.message}`);
      }

      if (error?.stack) {
        context.error(error.stack);
      }
    }
  }
});