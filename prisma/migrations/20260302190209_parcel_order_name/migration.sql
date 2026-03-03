-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Parcel" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL DEFAULT '',
    "fulfillmentId" TEXT NOT NULL,
    "carrierId" INTEGER,
    "carrierName" TEXT NOT NULL,
    "awbNumber" TEXT NOT NULL,
    "length" REAL NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL NOT NULL,
    "weight" REAL NOT NULL,
    "dispatchStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Parcel" ("awbNumber", "carrierId", "carrierName", "createdAt", "dispatchStatus", "fulfillmentId", "height", "id", "length", "orderId", "updatedAt", "weight", "width") SELECT "awbNumber", "carrierId", "carrierName", "createdAt", "dispatchStatus", "fulfillmentId", "height", "id", "length", "orderId", "updatedAt", "weight", "width" FROM "Parcel";
DROP TABLE "Parcel";
ALTER TABLE "new_Parcel" RENAME TO "Parcel";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
