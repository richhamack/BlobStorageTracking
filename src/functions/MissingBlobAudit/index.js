const { BlobServiceClient } = require("@azure/storage-blob");
const { app } = require("@azure/functions");

const auditCronSchedule = process.env.AUDIT_CRON_SCHEDULE || "0 */5 * * * *";

app.timer("MissingBlobAudit", {
  schedule: auditCronSchedule,
  handler: async (MissingBlobAuditTimer, context) => {
  context.log("Timer function started at", new Date().toISOString());

  try {
    // CONFIGURE THESE
    const containerName = process.env.AUDIT_CONTAINER;
    if (!containerName) {
      context.log("AUDIT_CONTAINER app setting not configured");
      return;
    }

    const ageMinutes = Number(process.env.AUDIT_AGE_MINUTES || 10);
    const prefix = process.env.AUDIT_PREFIX || undefined;

    const conn =
      process.env.BlobStorage ||
      process.env.AzureWebJobsStorage;

    if (!conn) {
      context.log("No storage connection configured (BlobStorage or AzureWebJobsStorage).");
      return;
    }

    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(containerName);

    if (!(await container.exists())) {
      context.log(`Container '${containerName}' does not exist.`);
      return;
    }

    const thresholdMs = ageMinutes * 60 * 1000;
    const now = Date.now();

    let scanned = 0;
    let offenders = 0;

    const listOptions = { includeMetadata: true, prefix };

    for await (const item of container.listBlobsFlat(listOptions)) {
      scanned++;

      const lastModified = item.properties?.lastModified;
      if (!lastModified) continue;

      const ageMs = now - new Date(lastModified).getTime();
      if (ageMs < thresholdMs) continue;

      const meta = {};
      if (item.metadata) {
        for (const [k, v] of Object.entries(item.metadata)) {
          meta[k.toLowerCase()] = v;
        }
      }

      const cosmos = meta["cosmosid"];
      const reason = meta["noingestionreason"];

      const missingCosmosId = !(cosmos && String(cosmos).trim());
      const missingNoIngest = !(reason && String(reason).trim());

      if (missingCosmosId && missingNoIngest) {
        offenders++;

        // 🔥 LOG AN ERROR FOR AZURE MONITOR ALERTING
        context.error(
          `MISSING BLOB DETECTED: name='${item.name}', lastModified='${new Date(lastModified).toISOString()}'`
        );
      }
    }

    context.log(
      `Scan complete. Scanned=${scanned}, offenders=${offenders}, container=${containerName}`
    );

  } catch (err) {
    context.log("Audit error:", err);
  }
  }
});