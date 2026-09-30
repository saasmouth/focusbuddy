/**
 * Which mailbox a stored message belongs to.
 *
 * Every row in the local mail store is partitioned by this key, so anything that
 * computes it differently reads an empty store and reports, honestly but wrongly,
 * that the mail is not there.
 *
 * It lived as the same one-line expression in two files, and a third was about to
 * be added in the renderer when mail-thread widgets started recording the account
 * they were pinned from. Two copies of a partition key is a bug with a delay on
 * it; three is asking for it. Anything needing the key imports this.
 *
 * Lowercased because IMAP usernames are case-insensitive in practice and the same
 * person typing Michael@… once would otherwise get a second, empty partition.
 */
export const mailAccountKey = (user: string): string => user.trim().toLowerCase()
