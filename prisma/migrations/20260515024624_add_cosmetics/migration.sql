-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'PURCHASE';

-- CreateTable
CREATE TABLE "cosmetics" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "priceChips" BIGINT NOT NULL,
    "previewAssetName" TEXT,
    "unlockCondition" TEXT NOT NULL DEFAULT 'purchase',
    "isLimitedTime" BOOLEAN NOT NULL DEFAULT false,
    "availableUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cosmetics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cosmetic_ownerships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cosmeticId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cosmetic_ownerships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipped_cosmetics" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cosmeticId" TEXT NOT NULL,
    "equippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipped_cosmetics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cosmetic_ownerships_userId_idx" ON "cosmetic_ownerships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "cosmetic_ownerships_userId_cosmeticId_key" ON "cosmetic_ownerships"("userId", "cosmeticId");

-- CreateIndex
CREATE INDEX "equipped_cosmetics_userId_idx" ON "equipped_cosmetics"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "equipped_cosmetics_userId_category_key" ON "equipped_cosmetics"("userId", "category");

-- AddForeignKey
ALTER TABLE "cosmetic_ownerships" ADD CONSTRAINT "cosmetic_ownerships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cosmetic_ownerships" ADD CONSTRAINT "cosmetic_ownerships_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "cosmetics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipped_cosmetics" ADD CONSTRAINT "equipped_cosmetics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipped_cosmetics" ADD CONSTRAINT "equipped_cosmetics_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "cosmetics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
