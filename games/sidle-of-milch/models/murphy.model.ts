import { withDefaults } from 'aige/model';
import base from './templates/murphy.model.ts';

/** murphy: game version with UVs and neutral vertex tints for the scanned fabric materials (see build/house.ts). */
export default withDefaults(base, { textured: true }, { name: 'murphy' });
