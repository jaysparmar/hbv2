const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`UPDATE Package SET valueOfRepayment = NULL WHERE valueOfRepayment = 0 OR valueOfRepayment = '0'`);
  await prisma.$executeRawUnsafe(`UPDATE Package SET valueOfRepayment = CAST(valueOfRepayment AS TEXT) WHERE valueOfRepayment IS NOT NULL`);
  
  await prisma.$executeRawUnsafe(`UPDATE Parcel SET valueOfRepayment = NULL WHERE valueOfRepayment = 0 OR valueOfRepayment = '0'`);
  await prisma.$executeRawUnsafe(`UPDATE Parcel SET valueOfRepayment = CAST(valueOfRepayment AS TEXT) WHERE valueOfRepayment IS NOT NULL`);
  console.log("Database updated successfully");
}

main().catch(console.error).finally(() => prisma.$disconnect());
