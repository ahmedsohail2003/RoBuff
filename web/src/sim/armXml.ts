/**
 * The Menagerie arm XML stays byte-identical on disk. It has no sites, and MJCF cannot
 * add a site to an included body from outside, so they are inserted when it is loaded.
 */

/** Site names added to the jaw bodies. */
export const GRIPPER_SITE = 'gripper';
export const FIXED_PAD_SITE = 'fixed_pad_tip';
export const MOVING_PAD_SITE = 'moving_pad_tip';

/**
 * Positions come from the pad geoms in so_arm100.xml. Each pad is 1 mm half-thick, so
 * the pad tip sites sit on the inner faces and their distance is the clear jaw gap.
 */
/** Inner face of the fixed jaw tip pad, along the gripper site's x (jaw closing) axis, in metres. */
export const FIXED_PAD_FACE_X = 0.0079;
const FIXED_JAW_SITES = `
    <site name="${GRIPPER_SITE}" pos="0 -0.0965 0" size="0.003" group="4"/>
    <site name="${FIXED_PAD_SITE}" pos="${FIXED_PAD_FACE_X} -0.1014 0" size="0.001" group="4"/>`;
const MOVING_JAW_SITES = `
    <site name="${MOVING_PAD_SITE}" pos="-0.0123 -0.077 0" size="0.001" group="4"/>`;

function insertAfterBodyTag(xml: string, bodyName: string, inserted: string): string {
  const tag = new RegExp(`<body name="${bodyName}"[^>]*>`);
  if (!tag.test(xml)) throw new Error(`arm XML has no body named ${bodyName}`);
  return xml.replace(tag, (match) => match + inserted);
}

export function patchArmXml(xml: string): string {
  return insertAfterBodyTag(insertAfterBodyTag(xml, 'Fixed_Jaw', FIXED_JAW_SITES), 'Moving_Jaw', MOVING_JAW_SITES);
}

/** Mesh file names the arm XML refers to, so the loader needs no separate list. */
export function meshFilesIn(xml: string): string[] {
  return [...xml.matchAll(/<mesh\b[^>]*\bfile="([^"]+)"/g)].map((match) => match[1]!);
}
