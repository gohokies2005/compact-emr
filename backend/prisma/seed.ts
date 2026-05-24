import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.cognitoGroup.createMany({
    data: [{ name: 'physician' }, { name: 'ops_staff' }, { name: 'admin' }],
    skipDuplicates: true,
  });

  const adminSub = process.env.BOOTSTRAP_ADMIN_SUB ?? 'local-admin-sub';
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@flatratenexus.local';
  const admin = await prisma.appUser.upsert({
    where: { cognitoSub: adminSub },
    update: { email: adminEmail },
    create: { cognitoSub: adminSub, email: adminEmail },
  });
  await prisma.appUserRole.upsert({
    where: { userId_role: { userId: admin.id, role: 'admin' } },
    update: {},
    create: { userId: admin.id, role: 'admin' },
  });

  if (process.env.SEED_DEMO_DATA === 'true') {
    await prisma.veteran.createMany({
      data: [
        { id: 'VET-00001', lastName: 'Adams', firstName: 'James', dob: new Date('1982-04-12'), email: 'james.adams@example.test', branch: 'Army', serviceStartYear: 2002, serviceEndYear: 2010, combatVeteran: 'yes', pactArea: 'yes', teraConceded: 'unknown', heightIn: 70, weightLb: 210 },
        { id: 'VET-00002', lastName: 'Bennett', firstName: 'Maria', dob: new Date('1978-08-03'), email: 'maria.bennett@example.test', branch: 'Navy', serviceStartYear: 1998, serviceEndYear: 2006, combatVeteran: 'no', pactArea: 'unknown', teraConceded: 'unknown', heightIn: 65, weightLb: 165 },
        { id: 'VET-00003', lastName: 'Chen', firstName: 'Robert', dob: new Date('1990-11-22'), email: 'robert.chen@example.test', branch: 'Air Force', serviceStartYear: 2011, serviceEndYear: 2018, combatVeteran: 'unknown', pactArea: 'no', teraConceded: 'no', heightIn: 72, weightLb: 190 },
      ],
      skipDuplicates: true,
    });

    await prisma.case.createMany({
      data: [
        { id: 'CASE-00001', veteranId: 'VET-00001', claimedCondition: 'Obstructive Sleep Apnea', claimType: 'supplemental', status: 'intake', veteranStatement: 'Veteran reports worsening snoring and daytime fatigue after PTSD symptoms.' },
        { id: 'CASE-00002', veteranId: 'VET-00002', claimedCondition: 'Migraine Headaches', claimType: 'initial', status: 'records', veteranStatement: 'Veteran reports headaches beginning during deployment.' },
      ],
      skipDuplicates: true,
    });
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
