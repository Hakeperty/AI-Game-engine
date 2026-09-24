using Godot;

namespace Aige;

/// <summary>
/// AIGE models carry colour, painted detail and baked ambient occlusion in glTF vertex colours (COLOR_0), but
/// Godot's glTF importer leaves <c>vertex_color_use_as_albedo</c> off, so they would render white. This turns it
/// on for every mesh surface that has vertex colours as it enters the tree.
/// </summary>
public static class VertexColors
{
    private static bool _hooked;

    /// <summary>Starts fixing meshes as they are added to the tree (called once by the Story autoload).</summary>
    public static void Hook(SceneTree tree)
    {
        if (_hooked) return;
        _hooked = true;
        tree.NodeAdded += node =>
        {
            if (node is MeshInstance3D mi) Callable.From(() => Fix(mi)).CallDeferred();
        };
    }

    /// <summary>Enables vertex colours as albedo on the surfaces of <paramref name="mi"/> that have them.</summary>
    public static void Fix(MeshInstance3D mi)
    {
        if (!GodotObject.IsInstanceValid(mi) || mi.Mesh is not ArrayMesh mesh) return;
        // Character skin parts (skin_head, skin_arms, ...) get subsurface scattering, the soft light
        // bleeding through skin that keeps faces from looking like plastic.
        var skin = mi.Name.ToString().StartsWith("skin", System.StringComparison.OrdinalIgnoreCase);
        for (var i = 0; i < mesh.GetSurfaceCount(); i++)
        {
            var hasColors = (mesh.SurfaceGetFormat(i) & Mesh.ArrayFormat.FormatColor) != 0;
            if (mi.GetActiveMaterial(i) is not BaseMaterial3D mat) continue;
            if (!(hasColors && !mat.VertexColorUseAsAlbedo) && !(skin && !mat.SubsurfScatterEnabled)) continue;
            var copy = (BaseMaterial3D)mat.Duplicate();
            if (hasColors) copy.VertexColorUseAsAlbedo = true;
            if (skin)
            {
                copy.SubsurfScatterEnabled = true;
                copy.SubsurfScatterSkinMode = true;
                copy.SubsurfScatterStrength = 0.3f;
                copy.Roughness = Mathf.Clamp(copy.Roughness, 0.45f, 0.6f);
            }
            mi.SetSurfaceOverrideMaterial(i, copy);
        }
    }
}
