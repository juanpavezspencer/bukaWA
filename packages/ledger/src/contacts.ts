import { contacts, type Tx } from "@bukuwa/db";
import { contactKey, displayContactName } from "@bukuwa/idn";
import { assertScope } from "./scope.js";

/*
 * Contacts are created on the fly from chat (spec 6). "Bu Sari", "ibu sari"
 * and "Sari" are one contact: matching uses contactKey(). MVP volumes are
 * small, so a scan of the business's contacts is fine.
 */

export type ContactKind = "customer" | "supplier" | "other";

export async function findContact(tx: Tx, businessId: string, name: string): Promise<{ id: string; name: string } | undefined> {
  await assertScope(tx, businessId);
  const key = contactKey(name);
  if (!key) return undefined;
  const all = await tx.select({ id: contacts.id, name: contacts.name }).from(contacts);
  return all.find((c) => contactKey(c.name) === key);
}

export async function findOrCreateContact(tx: Tx, businessId: string, name: string, kind: ContactKind): Promise<string> {
  const found = await findContact(tx, businessId, name);
  if (found) return found.id;
  if (!contactKey(name)) throw new Error("contact name is empty");
  const [row] = await tx.insert(contacts).values({ businessId, name: displayContactName(name), kind }).returning({ id: contacts.id });
  return row!.id;
}
