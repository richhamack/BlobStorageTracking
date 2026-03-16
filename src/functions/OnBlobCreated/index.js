
const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { app } = require('@azure/functions');

app.storageBlob('OnBlobCreated', {
  path: 'landingjs/{name}',
  connection: 'BlobStorage',
  handler: async (blob, context) => {
    const name = context.triggerMetadata?.name;
    const uri = context.triggerMetadata?.uri;
    const storageConnectionString = process.env.BlobStorage;
    const size = Buffer.isBuffer(blob)
      ? blob.length
      : Buffer.byteLength(String(blob));

    context.log('Blob trigger fired!');
    context.log(`Name: ${name}`);
    context.log(`URI: ${uri}`);
    context.log(`Size: ${size} bytes`);

    if (!storageConnectionString) {
      context.log('BlobStorage is not configured. Skipping metadata update.');
      return;
    }


    const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    const containerClient = blobServiceClient.getContainerClient('landingjs');
    const blobClient = containerClient.getBlobClient(name);

    const blobProperties = await blobClient.getProperties();
    const existingMetadata = blobProperties.metadata || {};
    const existingCosmosId = existingMetadata.cosmosId || existingMetadata.cosmosid;
    const existingNoIngestionReason = existingMetadata.noingestionreason || existingMetadata.noIngestionReason;

    if (existingCosmosId) {
      context.log(`cosmosId was already present for blob '${name}' with value '${existingCosmosId}'. Exiting without update.`);
      return;
    }
    if (existingNoIngestionReason) {
      context.log(`noIngestionReason was already present for blob '${name}' with value '${existingNoIngestionReason}'. Exiting without update.`);
      return;
    }

    const noIngestionReason = "Blob name starts with 'ignore', so skipping ingestion.";
    if (name.toLowerCase().startsWith('ignore')) {
      await blobClient.setMetadata({
        ...existingMetadata,
        noIngestionReason
      });
      context.log(`noIngestionReason metadata set for blob '${name}': ${noIngestionReason}`);
      return;
    }

    const cosmosId = crypto.randomUUID();
    await blobClient.setMetadata({
      ...existingMetadata,
      cosmosId
    });

    context.log(`cosmosId metadata set for blob '${name}': ${cosmosId}`);
  }
});
