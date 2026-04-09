-- CreateTable
CREATE TABLE "AddonProduct" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ParcelAddon" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "parcelId" INTEGER NOT NULL,
    "addonId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ParcelAddon_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "Parcel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ParcelAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "AddonProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ParcelAddon_parcelId_addonId_key" ON "ParcelAddon"("parcelId", "addonId");
