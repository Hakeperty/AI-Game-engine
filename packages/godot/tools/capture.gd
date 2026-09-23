extends SceneTree
## AIGE screenshot tool (independent of the game's C#, so it works even when scripts don't compile).
## godot --path <game> --windowed --resolution 1280x720 -s res://addons/aige/Tools/capture.gd -- <shots.json>
## shots.json: {"scene": "res://godot/scenes/house.tscn", "settle": 45, "shots": [
##   {"position": [x, y, z], "target": [x, y, z], "fov": 65, "out": "C:/abs/shot_0.png"}, ...]}

var _job: Dictionary
var _cam: Camera3D
var _idx := 0
var _frame := 0


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		push_error("capture.gd: pass the shots JSON path after --")
		quit(2)
		return
	_job = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var packed: PackedScene = load(_job["scene"])
	if packed == null:
		push_error("capture.gd: cannot load %s" % _job["scene"])
		quit(3)
		return
	root.add_child(packed.instantiate())
	_cam = Camera3D.new()
	root.add_child(_cam)


func _aim(shot: Dictionary) -> void:
	var p: Array = shot["position"]
	var t: Array = shot["target"]
	_cam.fov = float(shot.get("fov", 65.0))
	_cam.look_at_from_position(Vector3(p[0], p[1], p[2]), Vector3(t[0], t[1], t[2]))
	_cam.make_current()


func _process(_delta: float) -> bool:
	var shots: Array = _job.get("shots", [])
	if _idx >= shots.size():
		quit()
		return true
	if _frame == 0:
		_aim(shots[_idx])
	_frame += 1
	# the first shot waits for GI, fog and shadows to settle; later ones only for temporal AA
	var wait := int(_job.get("settle", 45)) if _idx == 0 else 12
	if _frame >= wait:
		root.get_texture().get_image().save_png(shots[_idx]["out"])
		_idx += 1
		_frame = 0
	return false
