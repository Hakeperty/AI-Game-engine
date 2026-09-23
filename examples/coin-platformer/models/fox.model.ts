import { withDefaults } from 'aige/model';
import base from './templates/creature.model.ts';

/** fox: variant of the 'creature' template. */
export default withDefaults(base, {}, { name: "fox" });
