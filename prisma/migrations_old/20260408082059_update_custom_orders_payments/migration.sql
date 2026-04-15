-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CustomOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderName" TEXT NOT NULL,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "zip" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "phone" TEXT,
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "items" TEXT,
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'UNFULFILLED',
    "partialPaymentAmount" REAL DEFAULT 0,
    "discountType" TEXT,
    "discountValue" REAL DEFAULT 0,
    "orderType" TEXT NOT NULL DEFAULT 'Standard',
    "partialPaymentLink" TEXT,
    "remainingPaymentLink" TEXT,
    "fullPaymentLink" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CustomOrder" ("address1", "address2", "city", "country", "createdAt", "customerEmail", "customerName", "customerPhone", "fulfillmentStatus", "id", "items", "orderName", "paymentStatus", "phone", "province", "totalAmount", "updatedAt", "zip") SELECT "address1", "address2", "city", "country", "createdAt", "customerEmail", "customerName", "customerPhone", "fulfillmentStatus", "id", "items", "orderName", "paymentStatus", "phone", "province", "totalAmount", "updatedAt", "zip" FROM "CustomOrder";
DROP TABLE "CustomOrder";
ALTER TABLE "new_CustomOrder" RENAME TO "CustomOrder";
CREATE UNIQUE INDEX "CustomOrder_orderName_key" ON "CustomOrder"("orderName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
