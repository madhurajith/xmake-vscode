-- imports
import("core.project.config")
import("clang.compile_commands", {rootdir = path.join(os.programdir(), "plugins", "project")})

-- main entry
function main()

    -- generate compile_commands.json
    -- @note we can only load configuration because we watched onFileChanged(xmake.conf)
    config.load()
    compile_commands._make_all(io.stdout)
end
