import { Behaviour, Game, Time, UI } from 'aige';

/** Shows the run time in the top-right corner and freezes it when the level is won. */
export default class LevelTimer extends Behaviour {
  static props = { id: 'timer' };
  private finished = false;

  start() {
    UI.text(this.props.id, 'Time: 0.0 s', { anchor: 'top-right', fontSize: 26 });
    Game.on('win', () => {
      this.finished = true;
      UI.text(this.props.id, `Finished in ${Time.time.toFixed(1)} s`, { anchor: 'top-right', fontSize: 26 });
    });
  }

  update() {
    if (!this.finished) UI.text(this.props.id, `Time: ${Time.time.toFixed(1)} s`, { anchor: 'top-right', fontSize: 26 });
  }
}
