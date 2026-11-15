import fs from 'node:fs';
import path from 'node:path';
import { cert, getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';

let adminDb: Firestore | null = null;
let initAttempted = false;
let initMode: 'service_account' | 'adc' | 'local_only' = 'local_only';

function loadAppletConfig(): { projectId?: string; firestoreDatabaseId?: string } {
  try {
    const configPath = path.resolve('./firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    // ignore
  }
  return {};
}

export function getAdminFirestore(): { db: Firestore | null; mode: string } {
  if (initAttempted) {
    return { db: adminDb, mode: initMode };
  }
  initAttempted = true;

  const appletConfig = loadAppletConfig();
  const databaseId = appletConfig.firestoreDatabaseId || '(default)';
  const projectId = appletConfig.projectId;

  try {
    const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (rawSa) {
      const jsonStr = rawSa.startsWith('{')
        ? rawSa
        : Buffer.from(rawSa, 'base64').toString('utf8');
      const serviceAccount = JSON.parse(jsonStr);
      const app =
        getApps().length > 0
          ? getApps()[0]
          : initializeApp({
              credential: cert(serviceAccount),
              projectId: serviceAccount.project_id || projectId,
            });
      adminDb = getFirestore(app, databaseId);
      initMode = 'service_account';
      console.log(`[Firestore Admin] Connected via Service Account to DB "${databaseId}".`);
      return { db: adminDb, mode: initMode };
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE) {
      const app =
        getApps().length > 0
          ? getApps()[0]
          : initializeApp({
              credential: applicationDefault(),
              projectId,
            });
      adminDb = getFirestore(app, databaseId);
      initMode = 'adc';
      console.log(`[Firestore Admin] Connected via Application Default Credentials to DB "${databaseId}".`);
      return { db: adminDb, mode: initMode };
    }
  } catch (err) {
    console.warn('[Firestore Admin] Admin SDK unavailable; using local JSON + browser Firestore sync:', (err as Error).message);
    adminDb = null;
    initMode = 'local_only';
  }

  return { db: adminDb, mode: initMode };
}

export async function adminSaveDocument(
  collectionName: string,
  docId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  const { db } = getAdminFirestore();
  if (!db) return false;
  try {
    await db.collection(collectionName).doc(docId).set(
      {
        ...data,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  } catch (err) {
    console.warn(`[Firestore Admin] Failed saving ${collectionName}/${docId}:`, (err as Error).message);
    return false;
  }
}

export async function adminLoadCollection<T>(collectionName: string): Promise<Array<T & { id: string }>> {
  const { db } = getAdminFirestore();
  if (!db) return [];
  try {
    const snap = await db.collection(collectionName).limit(500).get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
  } catch (err) {
    console.warn(`[Firestore Admin] Failed reading ${collectionName}:`, (err as Error).message);
    return [];
  }
}

export async function adminLoadDocument<T>(collectionName: string, docId: string): Promise<T | null> {
  const { db } = getAdminFirestore();
  if (!db) return null;
  try {
    const docSnap = await db.collection(collectionName).doc(docId).get();
    if (!docSnap.exists) return null;
    return docSnap.data() as T;
  } catch (err) {
    console.warn(`[Firestore Admin] Failed reading ${collectionName}/${docId}:`, (err as Error).message);
    return null;
  }
}

export async function adminDeleteDocument(collectionName: string, docId: string): Promise<boolean> {
  const { db } = getAdminFirestore();
  if (!db) return false;
  try {
    await db.collection(collectionName).doc(docId).delete();
    return true;
  } catch (err) {
    console.warn(`[Firestore Admin] Failed deleting ${collectionName}/${docId}:`, (err as Error).message);
    return false;
  }
}

export async function adminSaveSubDocument(
  collectionName: string,
  docId: string,
  subCollectionName: string,
  subDocId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  const { db } = getAdminFirestore();
  if (!db) return false;
  try {
    await db
      .collection(collectionName)
      .doc(docId)
      .collection(subCollectionName)
      .doc(subDocId)
      .set(
        {
          ...data,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    return true;
  } catch (err) {
    console.warn(
      `[Firestore Admin] Failed saving ${collectionName}/${docId}/${subCollectionName}/${subDocId}:`,
      (err as Error).message
    );
    return false;
  }
}

export async function adminLoadSubCollection<T>(
  collectionName: string,
  docId: string,
  subCollectionName: string,
  maxItems = 500
): Promise<Array<T & { id: string }>> {
  const { db } = getAdminFirestore();
  if (!db) return [];
  try {
    const snap = await db
      .collection(collectionName)
      .doc(docId)
      .collection(subCollectionName)
      .limit(maxItems)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
  } catch (err) {
    console.warn(
      `[Firestore Admin] Failed reading ${collectionName}/${docId}/${subCollectionName}:`,
      (err as Error).message
    );
    return [];
  }
}
