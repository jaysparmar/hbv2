-- CreateTable
CREATE TABLE "TransactionHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderName" TEXT NOT NULL,
    "amountPaid" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "paymentLinkId" TEXT,
    "paymentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "TransactionHistory_orderName_idx" ON "TransactionHistory"("orderName");
