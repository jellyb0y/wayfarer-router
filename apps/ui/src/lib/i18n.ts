/**
 * Translation indirection, in from the first commit.
 *
 * Deliberately tiny: a dictionary and a lookup. A library would be a dependency in a bundle that
 * is served from an SD card over Wi-Fi, and the requirement is that adding a language is a file,
 * not that plurals and dates are handled by someone else's abstraction.
 */
const en = {
  'app.title': 'Wayfarer',
  'nav.status': 'Status',
  'nav.clients': 'Clients',
  'auth.title': 'Sign in',
  'auth.password': 'Password',
  'auth.submit': 'Sign in',
  'auth.failed': 'Wrong password.',
  'auth.locked': 'Too many attempts. Wait and try again.',
  'password.current': 'Current password',
  // The length rule was inside this label. A label is at most three words, so the rule is now the one
  // sentence of help beside the two fields — which is also the only place it explains the disabled
  // button, and a disabled control with no reason beside it is the defect this pass removes.
  'password.new': 'New password',
  'password.rule': 'At least 12 characters.',
  'password.submit': 'Change password',
  'password.changed': 'Password changed.',
  /*
   * Status.
   *
   * The verdict lines are the only strings in this file allowed to be a judgement rather than a
   * name, because the screen's whole job is to reach one. Everything else here is a label, and a
   * label is at most three words — a longer one is a sentence that has wandered onto a screen.
   */
  'status.verdictOk': 'Working',
  'status.verdictWarn': 'Working, with problems',
  'status.verdictBad': 'Not working',
  'status.verdictUnknown': 'No reading yet',
  'status.problems': 'Problems',
  'status.matchesProfile': 'Running the stored profile',
  'status.matchesProfileOk': 'Everything this profile describes is in force on this device',
  'status.matchesProfileNo': 'Not looked at yet. This is not the same as "nothing has changed"',
  'status.matchesProfileUnreadable': 'This device could not be compared with its stored profile',
  'status.matchesProfileNoProfile': 'No profile is active, so there is nothing this device should be running',
  'status.matchesProfileDiverged': 'This device is not running what the stored profile says',
  'status.profileSays': 'Profile',
  'status.deviceHolds': 'Device',
  'status.checkedAgo': 'Checked',
  'status.watching': 'What this device is watching',
  'status.watchingOk': 'Every watcher is running and has looked recently',
  'status.watchingProblems': 'A watcher is not running, has stopped looking, or sees a failure',
  'status.watchingUnknown': 'Not heard from the device yet. This is not the same as "all watching"',
  'status.lastLooked': 'Last looked',
  'status.lastActed': 'Last acted',
  'status.never': 'never',
  'status.observerOk': 'running',
  'status.observerStale': 'stale',
  'status.observerNotRunning': 'not running',
  'status.observerFailing': 'failing',
  'status.observerItem': 'Subject',
  'status.observerDid': 'Done about it',
  'status.whatToDo': 'What to do',
  'status.where': 'Where',
  'status.faultUnitStopped': 'Stopped',
  'status.faultUnitNotEnabled': 'Will not start at boot',
  'status.faultClock': 'Clock is wrong',
  'status.faultApDown': 'Access point down',
  'status.faultMissing': 'Not installed',
  'status.device': 'Device',
  'status.name': 'Name',
  'status.version': 'Version',
  'status.runtime': 'Runtime',
  'status.uptime': 'Uptime',
  'status.listening': 'Listening on',
  'status.api': 'Machine API',
  'status.clock': 'Clock',
  'status.clockOk': 'Synchronised',
  'status.clockWrong': 'Wrong',
  'status.units': 'Units',
  'status.running': 'Running',
  'status.atBoot': 'At boot',
  'status.noUnitFile': 'No unit file',
  'status.interfaces': 'Interfaces',
  'status.flags': 'Flags',
  'status.accessPoints': 'Access point',
  'status.noAccessPoint': 'No access point yet.',
  'status.channel': 'Channel',
  'status.clients': 'Clients',
  'status.uplink': 'Uplink',
  'status.noUplink': 'No uplink yet.',
  'status.connected': 'connected',
  'status.disconnected': 'down',
  'status.network': 'Network',
  'status.signal': 'Signal',
  'status.rate': 'Rate',
  'status.tunnels': 'Tunnels',
  'status.noProfile': 'No active profile.',
  /*
   * Said in full rather than shortened, because a blank where a health reading belongs is read as
   * "healthy" by everybody. The device measures this; the measurement does not reach here yet, and
   * the honest thing is to name which of those two it is.
   */
  'status.tunnelHealthPending': 'This device does not report tunnel health to the panel yet.',
  'status.binaries': 'Components',
  'status.installed': 'installed',
  'status.notInstalled': 'missing',
  'status.path': 'Path',
  'status.neededFor': 'Needed for',
  'status.warnings': 'About this hardware',
  'clients.title': 'Clients',
  'clients.connected': 'Connected now',
  'clients.none': 'Nobody is connected.',
  'clients.accessPoint': 'Access point',
  'clients.connectedFor': 'Connected for',
  'clients.recent': 'Arrivals and departures',
  'clients.noHistory': 'Nothing since this device started.',
  'clients.arrived': 'arrived',
  'clients.left': 'left',
  'clients.when': 'When',
  /*
   * Not "no clients". The daemon says whether it got through the list, so a screen that drew rows
   * alone would report an unanswered question as an answer — and it is the answer this screen exists
   * to give. `{0}` is the daemon's reason: "some may be missing" with no cause is a warning nobody
   * can act on.
   */
  'clients.notCounted': 'This access point did not finish listing its clients, so some may be missing: {0}.',
  /* A daemon older than the reason field sends none; the caveat still stands, and says so. */
  'clients.noReason': 'the device did not say why',
  /* Events. */
  'nav.events': 'Events',
  'events.ring': 'Kept events',
  'events.ringHolds':
    'Applies, profile switches, tunnel health, safe mode, sign-ins, lockouts and switch-offs. Not a request log.',
  'events.kept': '{0} of {1} rows kept',
  'events.matched': '{0} shown of the {1} kept',
  'events.level': 'Level',
  'events.kind': 'Kind',
  'events.when': 'When',
  'events.any': 'any',
  'events.clearFilter': 'Clear filter',
  'events.noneYet': 'Nothing has been recorded yet.',
  'events.noneMatch': 'Nothing in the ring matches this filter. The ring still holds everything counted above.',
  'events.journal': 'Journal',
  'events.journalIs': 'Everything this device logged since it started. Lost on the next power cut.',
  'events.unit': 'Unit',
  'events.anyUnit': 'any unit',
  'events.errors': 'errors and worse',
  'events.warnings': 'warnings and worse',
  'events.informational': 'informational',
  'events.everything': 'everything',
  /* Routing. */
  'nav.routing': 'Routes',
  'routing.noProfile': 'No profile is active, so there are no rules to show.',
  'routing.rules': 'Rules',
  'routing.matchedFromTop': 'Matched from the top. The first rule that matches decides.',
  'routing.anchor': 'anchor',
  'routing.does': 'Matches',
  'routing.sendsTo': 'Sends to',
  'routing.unknownKind': 'A rule this interface has no description for.',
  'routing.moveUp': 'Up',
  'routing.moveDown': 'Down',
  'routing.edit': 'Edit',
  'routing.remove': 'Remove',
  'routing.addRule': 'Add a rule',
  'routing.direct': 'Direct',
  'routing.block': 'Block',
  'routing.kindProtect': 'Protect own networks',
  'routing.kindResources': 'Tunnel resources',
  'routing.kindPrivate': 'Private space',
  'routing.kindRuleSet': 'Rule sets',
  'routing.kindDomain': 'Exact hosts',
  'routing.kindSuffix': 'Name suffixes',
  'routing.kindCidr': 'Address ranges',
  /*
   * Every one of these says "rule". A tunnel's `resources` are the same words at a different
   * pointer — that collision is how the tunnel's half stayed invisible, and the label is the only
   * place a person can tell them apart.
   */
  'routing.ruleSuffixes': 'Rule name suffixes',
  'routing.ruleDomains': 'Rule exact hosts',
  'routing.ruleCidrs': 'Rule address ranges',
  'routing.ruleSets': 'Rule set tags',
  'editing.savingOnly': 'Editing “{0}”, which this device is not running. It can be saved; applying is a step that belongs to the profile in use.',
  'editing.elsewhere': 'Editing “{0}”, not the running profile.',
  'editing.backToActive': 'Edit the running one',
  'editing.choose': 'Edit this one',
  'editing.editingThis': 'Being edited',
  'editing.saveFirst': 'Save or discard first',
  'editing.chooseHelp': 'The screens for tunnels, routing and the network edit whichever profile is picked here. Only the running one can be applied.',
  'routing.sets': 'Rule sets',
  'routing.setsAre': 'Lists of names and ranges a rule can point at by tag, instead of holding thousands of lines.',
  'routing.setUnnamed': 'No tag yet',
  'routing.setUnused': 'No rule uses it',
  'routing.setTag': 'Tag',
  'routing.setTagHelp': 'The name a rule points at; change it and rules naming the old one match nothing.',
  'routing.setType': 'Where from',
  'routing.setUrl': 'Address',
  'routing.setUrlHelp': 'Fetched over the direct path, so a set that is only reachable through a tunnel never arrives.',
  'routing.setInterval': 'Refetch every',
  /*
   * The consequence lives in the control that causes it. Left empty, this field is the reason
   * nothing can ever call the list out of date: the age is still shown, and no verdict is possible
   * because the profile never said how fast it goes stale.
   */
  'routing.setIntervalHelp': 'Hours; left empty, nothing can report this list as out of date.',
  'routing.setAgeUnknown': 'Age not reported',
  'routing.setOverdue': 'Out of date',
  'routing.setNeverFetched': 'Never fetched',
  'routing.setUnreadable': 'Could not read it',
  'routing.setPath': 'File path',
  'routing.setPathHelp': 'On this device; a path that does not exist stops the core starting.',
  'routing.setFormat': 'Format',
  'routing.setFormatAbsent': 'From the file name',
  'routing.addSet': 'Add a rule set',
  'routing.noRuleSets': 'No rule sets are defined in this profile, so any tag here will be refused.',
  'routing.definedHere': 'Defined here: {0}',
  'routing.tunnelAboveAnchor':
    'Rule {0} sends traffic into a tunnel above the protect anchor. If it matches your local or uplink network, this device becomes unreachable.',
  'routing.produces': 'Final rules',
  'routing.previewIs': 'Matched in this order. Interface names are the ones that will be generated.',
  'routing.previewUnavailable': 'Not available while a rule is mid-edit.',
  'routing.addedAutomatically': 'added automatically',
  'routing.pending': 'Pending',
  'routing.saved': 'Nothing unsaved.',
  'routing.unsaved': '{0} unsaved change(s).',
  /* Two different facts, because a bar that reported only the first once misled a first-time user. */
  'routing.notApplied': 'This profile is saved but the device is not running it. Review, then apply.',
  'routing.save': 'Save',
  'routing.discard': 'Discard',
  'routing.review': 'Review',
  /* Network. */
  'nav.network': 'Network',
  'network.accessPoint': 'Access point',
  'network.uplink': 'Uplink',
  'network.atLeast': 'at least {0}',
  'network.reach': 'Panel answers on',
  /*
   * By interface, because two addresses in one subnet answered differently on the bench board and a
   * list of addresses reads as one network that works.
   */
  'network.reachIs': 'The interfaces this panel is reachable on. Never a tunnel.',
  'network.reachUnknown': 'This device has not said where it is listening.',
  'network.answers': 'answers',
  'network.silent': 'silent',
  'network.address': 'Address',
  'network.noAddress': 'no address',
  'network.noInterface': 'no interface claims this',
  'network.why': 'Why',
  'network.unresolved': 'Named in the configuration and resolved to no address.',
  /*
   * Said rather than left blank. A refusal means something upstream offered a tunnel, which is a
   * defect to hear about — and a screen with nothing where it belongs reports that nothing was
   * refused, which is a claim this device has not made.
   */
  'network.refusalsUnreported':
    'This device does not yet report which interfaces were refused, so this screen cannot show that the tunnel prohibition fired. Nothing here means "not reported", not "nothing was refused".',
  'network.radios': 'Radios',
  'network.bands': 'Bands',
  'network.accessPointMode': 'Access point',
  'network.clientMode': 'Client',
  'network.bothAtOnce': 'Both at once',
  'network.sharedChannelOnly': 'one shared channel',
  'network.scanning': 'Scanning',
  'network.allowed': 'allowed',
  'network.refused': 'refused',
  'network.combinations': 'Interface combinations',
  'network.channels': 'Channels',
  'network.frequency': 'Frequency',
  'network.maxPower': 'Max power',
  'network.note': 'Note',
  'network.radar': 'Radar detection required.',
  'network.noChannels': 'No channel is permitted here.',
  'radio.regulatory': 'Regulatory domain',
  /*
   * Settings.
   *
   * Every one of these is a label of at most three words. The two that are sentences are the two
   * places a label would mislead: what a profile is, and that activating one is not applying it —
   * the second is on record as having misled a first-time user badly enough to leave the device
   * running a configuration the screen was not showing.
   */
  'nav.settings': 'Settings',
  'settings.password': 'Password',
  'settings.defaultPassword': 'Default password',
  'settings.defaultInPlace': 'Still in place',
  'settings.defaultChanged': 'Changed',
  'tokens.title': 'API tokens',
  'tokens.help': 'A token lets a script use this device’s API, within the scopes it was given.',
  'tokens.machine': 'Machine access',
  'tokens.machineOn': 'On',
  'tokens.machineOff': 'Off',
  'tokens.machineOffHelp': 'Every token is refused until someone runs `way machine-api on` on the device.',
  'tokens.scopes': 'Scopes',
  'tokens.created': 'Created',
  'tokens.lastUsed': 'Last used',
  'tokens.expires': 'Expires',
  'tokens.never': 'Never',
  'tokens.none': 'No tokens.',
  'tokens.name': 'Token name',
  'tokens.expiry': 'Expires after',
  'tokens.expiryNever': 'Never',
  'tokens.expiryHour': 'One hour',
  'tokens.expiryDay': 'One day',
  'tokens.expiryMonth': '30 days',
  'tokens.expiryYear': 'One year',
  'tokens.adminWarn': 'Admin can also create tokens, change the password and switch the device off.',
  'tokens.create': 'Create token',
  'tokens.shownOnce': 'Copy it now: it is shown this once and the device does not keep it.',
  'tokens.dismiss': 'I have copied it',
  'tokens.revoke': 'Revoke',
  'tokens.revokeConfirm': 'Revoke “{0}” now?',
  'tokens.revoked': 'Revoked. It stopped working at once.',
  'settings.profiles': 'Profiles',
  'settings.profilesHelp': 'One profile is one complete configuration, and exactly one is active.',
  /*
   * The one place a label would mislead, so the one place with help beside it.
   *
   * "Export with secrets" does not say that the credentials leave in clear and that the device writes
   * the act to its event ring, and nobody guesses either. This used to be a `title` on the button —
   * which is to say it was written down where a phone can never show it.
   */
  'settings.exportHelp': 'Export leaves secrets out. Export with secrets copies them in clear, and the device records it.',
  'settings.active': 'active',
  'settings.note': 'Note',
  'settings.missing': 'Missing',
  'settings.kind': 'Kind',
  'settings.updated': 'Updated',
  'settings.activate': 'Activate',
  'settings.activateBlocked': 'Fill secrets first',
  'settings.export': 'Export',
  'settings.exportSecrets': 'Export with secrets',
  'settings.delete': 'Delete',
  /*
   * The confirming label names **what disappears**, not what the button does.
   *
   * Somebody who has tapped one row lower finds that out from the label rather than from the result, and
   * there is no help sentence beside it because the name has already said everything a sentence would.
   */
  'settings.deleteConfirm': 'Delete “{0}” for good?',
  'settings.newName': 'Name',
  'settings.create': 'Create',
  'settings.import': 'Import from clipboard',
  'settings.newProfile': 'New profile',
  'settings.noProfiles': 'No profiles yet.',
  'settings.created': 'Created, with no uplink, access point or tunnel. That is a valid state.',
  'settings.activated': 'Active. The device runs it once a plan is applied.',
  'settings.exportedRedacted': 'Copied, with secrets redacted. Safe to share.',
  'settings.exportedFull': 'Copied, with secrets included.',
  'settings.exportedLeaking': 'Copied with secrets. {0} field(s) leave in clear: {1}.',
  'settings.imported': 'Imported “{0}”.',
  'settings.migrated': 'Written at schema version {0}.',
  'settings.importComplete': 'Nothing is missing. It can be activated as it is.',
  'settings.importMissing': '{0} secret(s) were removed when it was exported for sharing.',
  'settings.notApplied': 'Not applied',
  'settings.notAppliedHelp': 'This profile is stored. The device is not running it yet.',
  'settings.devices': 'Devices',
  /*
   * Switching the device off.
   *
   * The consequence is inside the button, not beside it, and the part a person must not miss is the
   * last clause: there is no power button on this board and nothing turns it back on. The confirming
   * label repeats it, because the second tap is the one that acts.
   */
  'power.title': 'Power',
  'power.turnOff': 'Turn off',
  'power.consequence': 'Wi-Fi and every tunnel go too; it will not come back on its own, only when its power is cycled.',
  'power.confirm': 'Turn off now',
  'power.confirmConsequence': 'It stays off until someone cycles its power.',
  'power.cancel': 'Keep it on',
  'power.sending': 'Turning off…',
  'power.blocked': 'Confirm change first',
  'power.blockedWhy': 'Change {0} awaits confirmation, and turning off now would undo it at the next start.',
  'power.off': 'Turning off',
  'power.offIs': 'The Wi-Fi and every tunnel are going, and it stays off until its power is cycled.',
  'power.offDone': 'This page has stopped asking the device for anything.',
  /*
   * The aggregate view.
   *
   * Three of these are sentences rather than labels, and deliberately: "unreachable" and "refused"
   * are different problems with different fixes, and a reader given one word for each reaches for
   * the wrong one. They are drawn as a row field, never as a pill, because a sentence in a pill is
   * what pushed the old table past the edge of the screen.
   */
  'fleet.self': 'this device',
  'fleet.answered': 'answered',
  'fleet.badgeRefused': 'refused',
  'fleet.badgeUnreachable': 'no answer',
  'fleet.refused': 'Working, but would not accept the stored token.',
  'fleet.unreachable': 'No answer. This may be the network between here and there, not the device.',
  'fleet.viewOnly': 'This asks each device for its own summary. Nothing here can change another device.',
  'fleet.duplicate':
    'Two of these report one identity ({0}), which almost always means a card was copied. Nothing has been changed.',
  'fleet.none': 'No other device is known here.',
  'fleet.state': 'State',
  'fleet.address': 'Address',
  'fleet.profile': 'Profile',
  'fleet.version': 'Version',
  'fleet.up': 'Up',
  'fleet.detail': 'Detail',
  'fleet.forget': 'Forget',
  'fleet.askAgain': 'Ask again',
  'fleet.asking': 'Asking…',
  'fleet.add': 'Add a device',
  'fleet.name': 'Name',
  'fleet.token': 'Read token',
  'fleet.tokenHelp': 'Create it on that device with the read scope. It cannot change anything there.',
  'fleet.addSubmit': 'Add',
  'diagnostics.earlierBoots': 'This view includes lines from an earlier boot.',
  'diagnostics.incomplete':
    'This page is incomplete — the read stopped early, so lines are missing from inside this window.',
  'diagnostics.currentBootEmpty':
    'The journal holds nothing for the current boot. After a power cut this is expected — the journal lives in RAM, and the event ring below is the only record of what happened.',
  'common.loading': 'Loading…',
  'common.yes': 'yes',
  'common.no': 'no',
  'common.unknown': 'unknown',
  'common.error': 'Something went wrong.',
  /*
   * Tunnels.
   *
   * Every one of these is a name or a state word. The three catalogue entries are deliberately
   * **not** here: they come from `TUNNEL_PROTOCOL_TITLES` in the schema package, so the words on this
   * screen cannot disagree with the words the device refuses by. The sentences that state a
   * consequence are not here either — they live inside the controls that cause them, which is where
   * rule 4 puts them and the one place a phone can always show them.
   */
  'settings.thisProfile': 'The active profile',
  'network.change': 'Change these',
  'network.local': 'This network',
  'network.names': 'Names',
  'network.rules': 'What may leave',
  'nav.tunnels': 'Tunnels',
  'tunnels.list': 'Tunnels',
  'tunnels.listIs': 'Each one is edited where it is listed.',
  'tunnels.none': 'No tunnels yet. Everything goes out the ordinary way, and no rule can send traffic anywhere else.',
  'tunnels.allDown': 'If every tunnel fails',
  'tunnels.carries': 'Carries',
  'tunnels.roleAlternative': 'Anything at all',
  'tunnels.roleResource': 'Only what it reaches',
  'tunnels.state': 'State',
  'tunnels.on': 'In use',
  'tunnels.off': 'Not in use',
  'tunnels.health': 'Health',
  'tunnels.healthUnread': 'Not read yet',
  // {0} is a time of day from the viewer's own clock: the device has no RTC and sends a monotonic duration.
  'tunnels.fallingThrough': 'Falling through — traffic is leaving outside the VPN since {0}',
  'tunnels.from': 'Source',
  'tunnels.fromSubscription': 'A subscription. A refresh replaces it.',
  'tunnels.remove': 'Remove',
  'tunnels.edit': 'Edit',
  'tunnels.add': 'Add a tunnel',
  'tunnels.addIs': 'Named for what you have, not for what this device starts.',
} as const;

export type MessageKey = keyof typeof en;

const dictionaries: Record<string, Partial<Record<MessageKey, string>>> = { en };

let language = 'en';

export function setLanguage(next: string): void {
  language = next;
}

/** Falls back to English, then to the key itself: a missing string must not blank a screen. */
export function t(key: MessageKey): string {
  return dictionaries[language]?.[key] ?? en[key] ?? key;
}

/**
 * The same lookup with positional substitution: `{0}`, `{1}`, in the order given.
 *
 * Positional rather than named because the position is what a translator can reorder — a language
 * that puts the capacity before the count writes `{1} of {0}` and nothing else changes. Values are
 * substituted as they arrive, so formatting a number stays the caller's decision.
 */
export function tf(key: MessageKey, ...values: (string | number)[]): string {
  return values.reduce<string>(
    (text, value, index) => text.split(`{${index}}`).join(String(value)),
    t(key),
  );
}
