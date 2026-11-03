// Ghidra headless post-script: decompile functions at the supplied addresses.
// Usage: analyzeHeadless <proj> <name> -import <dll> -scriptPath scripts/ghidra \
//        -postScript DecompileAddresses.java 0x10004A80 0x2549E390 ...
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;

public class DecompileAddresses extends GhidraScript {
    @Override
    public void run() throws Exception {
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        for (String arg : getScriptArgs()) {
            Address address = toAddr(arg);
            Function function = getFunctionAt(address);
            if (function == null) {
                disassemble(address);
                function = createFunction(address, null);
            }
            println("===== " + arg + " " + (function != null ? function.getName() : "NOFUNCTION") + " =====");
            if (function != null) {
                DecompileResults result = ifc.decompileFunction(function, 120, monitor);
                if (result.decompileCompleted()) {
                    println(result.getDecompiledFunction().getC());
                } else {
                    println("DECOMPILE FAILED: " + result.getErrorMessage());
                }
            }
        }
        ifc.dispose();
    }
}
