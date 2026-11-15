import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type {
  BotConfig,
  ChatMemoryRecord,
  DictionaryEntry,
  InboxNoteRecord,
} from '../types';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export function subscribeAuthState(cb: (user: User | null) => void) {
  return onAuthStateChanged(auth, cb);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutFirebase() {
  await signOut(auth);
}

export async function saveCloudSettings(uid: string, config: BotConfig) {
  const path = 'bot_settings/primary';
  try {
    const ref = doc(db, 'bot_settings', 'primary');
    let hasCreatedAt = false;
    try {
      const snap = await getDocFromServer(ref);
      hasCreatedAt = snap.exists() && Boolean(snap.data()?.createdAt);
    } catch {
      hasCreatedAt = false;
    }

    const payload: Record<string, unknown> = {
      ownerId: uid,
      autoreply: config.autoreply,
      aiAssistantEnabled: config.aiAssistantEnabled,
      autoreplyMessage: config.autoreplyMessage,
      firstGreetingTemplate: config.firstGreetingTemplate,
      ownerName: config.ownerName,
      ownerProfession: config.ownerProfession,
      ownerLocation: config.ownerLocation,
      ownerBio: config.ownerBio,
      ownerBoundaries: config.ownerBoundaries,
      strictLogicRules: config.strictLogicRules || '',
      assistantTone: config.assistantTone,
      cooldownMs: config.cooldownMs,
      takeoverPauseMs: config.takeoverPauseMs,
      humanTypingEnabled: config.humanTypingEnabled,
      dailyReplyLimit: config.dailyReplyLimit,
      antilinkGroups: config.antilinkGroups,
      groupAiEnabled: Boolean(config.groupAiEnabled),
      groupAiMode: config.groupAiMode || 'smart_blend',
      groupReactionEnabled: config.groupReactionEnabled !== false,
      groupCooldownMs: typeof config.groupCooldownMs === 'number' ? config.groupCooldownMs : 6000,
      groupAiGroups: config.groupAiGroups || {},
      updatedAt: serverTimestamp(),
    };

    if (!hasCreatedAt) {
      payload.createdAt = serverTimestamp();
    }
    await setDoc(ref, payload, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveCloudDictionaryEntry(uid: string, entry: DictionaryEntry) {
  const path = `dictionary_entries/${entry.id}`;
  try {
    const ref = doc(db, 'dictionary_entries', entry.id);
    await setDoc(
      ref,
      {
        ownerId: uid,
        term: entry.term,
        meaning: entry.meaning,
        district: entry.district,
        language: entry.language,
        replyStyleHint: entry.replyStyleHint || '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteCloudDictionaryEntry(id: string) {
  const path = `dictionary_entries/${id}`;
  try {
    await deleteDoc(doc(db, 'dictionary_entries', id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

function toIsoString(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof ts === 'string' && ts) return ts;
  return new Date().toISOString();
}

export async function fetchAllCloudData(uid: string): Promise<{
  settings: Partial<BotConfig> | null;
  dictionary: DictionaryEntry[];
  memories: ChatMemoryRecord[];
  notes: InboxNoteRecord[];
}> {
  let settings: Partial<BotConfig> | null = null;
  const dictionary: DictionaryEntry[] = [];
  const memories: ChatMemoryRecord[] = [];
  const notes: InboxNoteRecord[] = [];

  try {
    const settingsSnap = await getDocs(
      query(collection(db, 'bot_settings'), where('ownerId', '==', uid))
    );
    if (!settingsSnap.empty) {
      settings = settingsSnap.docs[0].data() as Partial<BotConfig>;
    } else {
      try {
        const primarySnap = await getDocFromServer(doc(db, 'bot_settings', 'primary'));
        if (primarySnap.exists()) {
          settings = primarySnap.data() as Partial<BotConfig>;
        }
      } catch {
        // non-admin or offline
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'bot_settings');
  }

  try {
    const dictSnap = await getDocs(
      query(collection(db, 'dictionary_entries'), where('ownerId', '==', uid))
    );
    dictSnap.forEach((d) => {
      const data = d.data();
      dictionary.push({
        id: d.id,
        term: String(data.term || ''),
        meaning: String(data.meaning || ''),
        district: String(data.district || 'General'),
        language: data.language || 'bn_dialect',
        replyStyleHint: String(data.replyStyleHint || ''),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'dictionary_entries');
  }

  try {
    const memSnap = await getDocs(
      query(collection(db, 'chat_memories'), where('ownerId', '==', uid))
    );
    memSnap.forEach((d) => {
      const data = d.data();
      memories.push({
        chatId: d.id,
        contactJid: String(data.contactJid || ''),
        contactName: String(data.contactName || ''),
        detectedDistrict: String(data.detectedDistrict || 'Standard'),
        lastSummary: String(data.lastSummary || ''),
        turns: Array.isArray(data.turns) ? data.turns : [],
        updatedAt: toIsoString(data.updatedAt),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'chat_memories');
  }

  try {
    const noteSnap = await getDocs(
      query(collection(db, 'inbox_notes'), where('ownerId', '==', uid))
    );
    noteSnap.forEach((d) => {
      const data = d.data();
      notes.push({
        id: d.id,
        contactJid: String(data.contactJid || ''),
        contactName: String(data.contactName || ''),
        summary: String(data.summary || ''),
        urgency: data.urgency === 'important' ? 'important' : 'normal',
        resolved: Boolean(data.resolved),
        createdAt: toIsoString(data.createdAt),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'inbox_notes');
  }

  return { settings, dictionary, memories, notes };
}
