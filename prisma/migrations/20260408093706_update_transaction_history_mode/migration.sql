-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TransactionHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderName" TEXT NOT NULL,
    "amountPaid" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "paymentLinkId" TEXT,
    "paymentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "mode" TEXT NOT NULL DEFAULT 'Razorpay',
    "documentUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_TransactionHistory" ("amountPaid", "createdAt", "currency", "id", "orderName", "paymentId", "paymentLinkId", "status") SELECT "amountPaid", "createdAt", "currency", "id", "orderName", "paymentId", "paymentLinkId", "status" FROM "TransactionHistory";
DROP TABLE "TransactionHistory";
ALTER TABLE "new_TransactionHistory" RENAME TO "TransactionHistory";
CREATE INDEX "TransactionHistory_orderName_idx" ON "TransactionHistory"("orderName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
