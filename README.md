# Blob Trigger vs Event Grid Trigger

This project now contains both trigger styles:

- `OnBlobCreated` (Blob Trigger / polling-based)
- `OnBlobCreatedEventGrid` (Event Grid / push-based)
- `OnBlobCreatedServiceBus` (Service Bus Topic Subscription / push-based)
- `RequeueBlobCreatedHttp` (HTTP trigger to reset metadata and republish BlobCreated event)

It also includes a timer-based audit function:

- `MissingBlobAudit` (scheduled scan for blobs missing ingestion metadata)

## Where each function lives

- Blob trigger: `src/functions/OnBlobCreated/index.js`
- Event Grid trigger: `src/functions/OnBlobCreatedEventGrid/index.js`
- Service Bus trigger: `src/functions/OnBlobCreatedServiceBus/index.js`
- HTTP requeue trigger: `src/functions/RequeueBlobCreatedHttp/index.js`
- Timer audit: `src/functions/MissingBlobAudit/index.js`

## MissingBlobAudit summary

`MissingBlobAudit` runs on a timer and scans a configured container for older blobs that appear to have fallen out of the ingestion flow.

### What it checks

- Reads blobs from `AUDIT_CONTAINER` (optionally filtered by `AUDIT_PREFIX`).
- Ignores blobs newer than `AUDIT_AGE_MINUTES` (default `10`).
- For older blobs, it inspects metadata keys case-insensitively:
  - `cosmosId`
  - `noIngestionReason`
- If **both** are missing/empty, it logs an error:
  - `MISSING BLOB DETECTED: ...`

### Schedule and configuration

- Schedule app setting: `AUDIT_CRON_SCHEDULE` (default `0 */5 * * * *`, every 5 minutes).
- Required setting: `AUDIT_CONTAINER`.
- Optional setting: `AUDIT_PREFIX`.
- Optional setting: `AUDIT_AGE_MINUTES`.
- Storage connection uses `BlobStorage` first, then falls back to `AzureWebJobsStorage`.

## Container mapping

- `OnBlobCreated` listens to `landingjs`.
- `OnBlobCreatedEventGrid` processes only `landingeventgrid` events.
- `OnBlobCreatedServiceBus` processes `landingeventgrid` events forwarded through Service Bus.

## Service Bus settings

`OnBlobCreatedServiceBus` uses these app settings:

- `ServiceBusConnection` (Service Bus namespace connection string)
- `SERVICE_BUS_TOPIC_NAME`
- `SERVICE_BUS_SUBSCRIPTION_NAME`

## HTTP requeue endpoint

`RequeueBlobCreatedHttp` accepts a blob URL, removes these metadata keys from the blob, then publishes a BlobCreated-style event array to Service Bus topic:

- `cosmosId`
- `noIngestionReason`

### Request

- Method: `POST`
- Auth: Function key (`authLevel: function`)
- Provide blob URL as either:
  - Query string: `?blobUrl=https://<account>.blob.core.windows.net/landingsb/file.pdf`
  - JSON body: `{ "blobUrl": "https://<account>.blob.core.windows.net/landingsb/file.pdf" }`
- Optional: `clearMetadata` (defaults to `false`)
  - Query: `?clearMetadata=true`
  - Body: `{ "blobUrl": "...", "clearMetadata": true }`

## High-level differences

| Area | OnBlobCreated (Blob Trigger) | OnBlobCreatedEventGrid (Event Grid Trigger) |
|---|---|---|
| Invocation model | Runtime scans storage and invokes function when new blob is detected | Event Grid pushes events to function endpoint |
| Trigger declaration | `app.storageBlob(...)` | `app.eventGrid(...)` |
| Blob identity source | `context.triggerMetadata.name` / `context.triggerMetadata.uri` | `event.data.url` (parsed into container + blob name) |
| Latency profile | Usually near-real-time, but can involve polling intervals | Near real-time push |
| Local development | Works well locally with Azurite/real storage | Requires Event Grid delivery path (best validated in Azure) |

## Equivalent business logic

Both functions currently do the same metadata behavior:

1. Read blob metadata.
2. If `cosmosId` exists, log and exit.
3. If `noIngestionReason` exists, log and exit.
4. If before 10:15 AM, set `noIngestionReason` and exit.
5. Otherwise set `cosmosId` to a new GUID.

## Event Grid event shape used by this function

`OnBlobCreatedEventGrid` expects:

- `event.eventType === "Microsoft.Storage.BlobCreated"`
- `event.data.url` containing full blob URL, for example:

```json
{
  "id": "6f0f9b3c-7f9f-4b6f-bf2f-4ef4dc1dfc3a",
  "topic": "/subscriptions/<subId>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>",
  "subject": "/blobServices/default/containers/landingeventgrid/blobs/sample.json",
  "eventType": "Microsoft.Storage.BlobCreated",
  "eventTime": "2026-03-16T18:20:00.0000000Z",
  "data": {
    "api": "PutBlob",
    "clientRequestId": "...",
    "requestId": "...",
    "eTag": "0x8DE4A1E2ABCD123",
    "contentType": "application/json",
    "contentLength": 123,
    "blobType": "BlockBlob",
    "url": "https://<account>.blob.core.windows.net/landingeventgrid/sample.json",
    "sequencer": "00000000000000000000000000001234",
    "storageDiagnostics": {
      "batchId": "..."
    }
  },
  "dataVersion": "",
  "metadataVersion": "1"
}
```

## Wiring Storage -> Event Grid -> Service Bus -> Function

### 1) Deploy function app

Deploy the Function App containing `OnBlobCreatedServiceBus`.

### 2) Create Service Bus topic + subscription

In your Service Bus namespace:

1. Create topic: `SERVICE_BUS_TOPIC_NAME` (example: `containerarrival`).
2. Create subscription: `SERVICE_BUS_SUBSCRIPTION_NAME` (example: `functionTrigger`).
3. Set app settings on the Function App:
   - `ServiceBusConnection`
   - `SERVICE_BUS_TOPIC_NAME`
   - `SERVICE_BUS_SUBSCRIPTION_NAME`

### 3) Create Event Grid subscription on storage account

In Azure Portal:

1. Open your Storage Account.
2. Go to **Events**.
3. Click **+ Event Subscription**.
4. Event types: select **Blob Created**.
5. Endpoint type: **Service Bus Topic**.
6. Choose your Service Bus namespace and topic (`SERVICE_BUS_TOPIC_NAME`).
7. Scope/filter:
  - Set subject begins with `/blobServices/default/containers/landingsb/`
  - This limits events to your `landingsb` container.

### 4) Validate

1. Upload a blob to `landingsb`.
2. Check Function logs.
3. Confirm metadata updates:
   - first run sets `cosmosId` (or `noIngestionReason` before 10:15)
   - subsequent run on same blob logs existing metadata and exits

## Wiring Storage -> Event Grid -> Function (direct)

If you want direct delivery without Service Bus:

1. Create Event Grid subscription with endpoint type **Azure Function**.
2. Target function: `OnBlobCreatedEventGrid`.
3. Filter subject by your target container (for example `/blobServices/default/containers/landingeventgrid/`).

## Notes

- Keep `BlobStorage` valid for runtime + metadata updates.
- Blob trigger and Event Grid trigger can coexist in this repo with separate containers (`landingjs` vs `landingeventgrid`).
- `OnBlobCreatedEventGrid` also enforces an in-code container check and ignores events not targeting `landingeventgrid`.
