const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");

let testEnv;
const PROJECT_ID = process.env.GCP_PROJECT || "demo-no-project";
const ALICE_UID = "alice_123";
const BOB_UID = "bob_456";

const [emulatorHost, emulatorPortStr] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085").split(":");
const emulatorPort = parseInt(emulatorPortStr, 10);

before(async () => {
  const rules = fs.readFileSync("./firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: emulatorHost,
      port: emulatorPort,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

test("Unauthenticated users cannot read or write notes, reminders, or chat messages", async () => {
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("notes").get());
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("reminders").get());
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("chatMessages").get());
  await assertFails(
    unauthDb.collection("users").doc(ALICE_UID).collection("notes").doc("note_1").set({
      userId: ALICE_UID,
      title: "Unauthorized",
      content: "Should fail",
      sourceType: "MANUAL",
      pinned: false,
      createdAt: new Date(Date.now() - 1000),
      updatedAt: new Date(Date.now() - 1000),
    })
  );
});

test("Owner can create, list, partially update, and delete notes matching Kotlin schema", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const created = new Date(Date.now() - 5000);
  const notesRef = aliceDb.collection("users").doc(ALICE_UID).collection("notes");

  // Empty collection list succeeds
  await assertSucceeds(notesRef.get());

  // Valid create payload (no @DocumentId `id` field)
  await assertSucceeds(
    notesRef.doc("note_1").set({
      userId: ALICE_UID,
      title: "বাংলা ভয়েস নোট",
      content: "আগামীকাল সকাল ১০টায় ডাক্তারের অ্যাপয়েন্টমেন্ট আছে।",
      sourceType: "VOICE",
      pinned: false,
      languageTag: "bn",
      createdAt: created,
      updatedAt: created,
    })
  );

  // Partial update payload
  await assertSucceeds(
    notesRef.doc("note_1").update({
      pinned: true,
      updatedAt: new Date(Date.now() - 1000),
    })
  );

  // Reject immutable createdAt modification
  await assertFails(
    notesRef.doc("note_1").update({
      createdAt: new Date(Date.now() - 500),
      updatedAt: new Date(Date.now() - 500),
    })
  );

  // Reject extra @DocumentId 'id' key on create
  await assertFails(
    notesRef.doc("note_2").set({
      id: "note_2",
      userId: ALICE_UID,
      title: "Bad note",
      content: "Has id field",
      sourceType: "MANUAL",
      pinned: false,
      createdAt: created,
      updatedAt: created,
    })
  );

  // Reject future tampered timestamp
  await assertFails(
    notesRef.doc("note_3").set({
      userId: ALICE_UID,
      title: "Future note",
      content: "Tampered timestamp",
      sourceType: "MANUAL",
      pinned: false,
      createdAt: new Date(Date.now() + 120000),
      updatedAt: new Date(Date.now() + 120000),
    })
  );

  // Delete succeeds for owner
  await assertSucceeds(notesRef.doc("note_1").delete());
});

test("Owner can create, update completion, and list reminders", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const created = new Date(Date.now() - 5000);
  const remindersRef = aliceDb.collection("users").doc(ALICE_UID).collection("reminders");

  await assertSucceeds(
    remindersRef.doc("rem_1").set({
      userId: ALICE_UID,
      title: "ডাক্তারের সাথে দেখা",
      details: "কার্ডিওলজি চেকআপ",
      dueAtMillis: Date.now() + 3600000,
      dueLabel: "Tomorrow, 10:00 AM",
      priority: "HIGH",
      category: "Health",
      completed: false,
      sourceText: "কাল সকাল ১০টায় ডাক্তারের সাথে দেখা",
      createdAt: created,
      updatedAt: created,
    })
  );

  await assertSucceeds(
    remindersRef.doc("rem_1").update({
      completed: true,
      updatedAt: new Date(Date.now() - 1000),
    })
  );

  // Reject invalid priority enum
  await assertFails(
    remindersRef.doc("rem_2").set({
      userId: ALICE_UID,
      title: "Invalid priority",
      dueAtMillis: Date.now() + 3600000,
      dueLabel: "Today",
      priority: "URGENT",
      category: "Work",
      completed: false,
      createdAt: created,
      updatedAt: created,
    })
  );

  await assertSucceeds(remindersRef.orderBy("dueAtMillis").get());
});

test("Owner can create, list, and delete chatMessages, while updates are blocked", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const chatRef = aliceDb.collection("users").doc(ALICE_UID).collection("chatMessages");

  await assertSucceeds(
    chatRef.doc("msg_1").set({
      userId: ALICE_UID,
      role: "USER",
      text: "আজকে আমার কাজের তালিকা গুছিয়ে দাও",
      languageHint: "bn",
      createdAt: new Date(Date.now() - 2000),
    })
  );

  await assertSucceeds(chatRef.orderBy("createdAt").get());
  await assertFails(chatRef.doc("msg_1").update({ text: "Tampered" }));
  await assertSucceeds(chatRef.doc("msg_1").delete());
});

test("Cross-user isolation: Alice cannot read or write Bob's data", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const bobRef = context.firestore().collection("users").doc(BOB_UID);
    const created = new Date(Date.now() - 10000);
    await bobRef.collection("notes").doc("bob_note").set({
      userId: BOB_UID,
      title: "Bob Private",
      content: "Secret note",
      sourceType: "MANUAL",
      pinned: false,
      createdAt: created,
      updatedAt: created,
    });
    await bobRef.collection("reminders").doc("bob_rem").set({
      userId: BOB_UID,
      title: "Bob Reminder",
      dueAtMillis: Date.now() + 3600000,
      dueLabel: "Later",
      priority: "LOW",
      category: "Personal",
      completed: false,
      createdAt: created,
      updatedAt: created,
    });
  });

  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  await assertFails(aliceDb.collection("users").doc(BOB_UID).collection("notes").get());
  await assertFails(aliceDb.collection("users").doc(BOB_UID).collection("notes").doc("bob_note").get());
  await assertFails(
    aliceDb.collection("users").doc(BOB_UID).collection("notes").doc("bob_note").update({
      title: "Hijacked",
      updatedAt: new Date(Date.now() - 500),
    })
  );
  await assertFails(aliceDb.collection("users").doc(BOB_UID).collection("reminders").get());
  await assertFails(
    aliceDb.collection("users").doc(BOB_UID).collection("reminders").doc("bob_rem").delete()
  );
  await assertFails(aliceDb.collection("users").doc(BOB_UID).collection("answerChecks").get());
});

test("Owner can create, list, and delete answerChecks matching Kotlin schema while enforcing score and verdict bounds", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  const checksRef = aliceDb.collection("users").doc(ALICE_UID).collection("answerChecks");
  const created = new Date(Date.now() - 2000);

  await assertFails(unauthDb.collection("users").doc(ALICE_UID).collection("answerChecks").get());

  await assertSucceeds(
    checksRef.doc("chk_1").set({
      userId: ALICE_UID,
      question: "বাংলাদেশের রাজধানী কী?",
      userAnswer: "ঢাকা বাংলাদেশের রাজধানী।",
      verdict: "CORRECT",
      score: 100,
      scoreReason: "সঠিক ও সম্পূর্ণ উত্তর।",
      correctParts: "ঢাকা বাংলাদেশের রাজধানী।",
      correctAnswer: "ঢাকা",
      detailedExplanation: "ঢাকা বাংলাদেশের রাজধানী ও বৃহত্তম শহর।",
      inputLanguage: "bn",
      createdAt: created,
    })
  );

  await assertSucceeds(checksRef.orderBy("createdAt", "desc").get());
  await assertFails(checksRef.doc("chk_1").update({ score: 50 }));

  // Reject out-of-range score
  await assertFails(
    checksRef.doc("chk_bad_score").set({
      userId: ALICE_UID,
      question: "2 + 2?",
      userAnswer: "4",
      verdict: "CORRECT",
      score: 105,
      scoreReason: "Out of range",
      detailedExplanation: "Invalid score",
      createdAt: created,
    })
  );

  // Reject unknown verdict enum
  await assertFails(
    checksRef.doc("chk_bad_verdict").set({
      userId: ALICE_UID,
      question: "2 + 2?",
      userAnswer: "4",
      verdict: "MAYBE",
      score: 50,
      scoreReason: "Bad enum",
      detailedExplanation: "Invalid enum",
      createdAt: created,
    })
  );

  await assertSucceeds(checksRef.doc("chk_1").delete());
});
