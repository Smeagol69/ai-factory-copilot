__declspec(dllexport) int copilot_scale(int value) {
    return value * 3 + 7;
}
void copilot_entry(void) {
    volatile int result = copilot_scale(5);
    for (;;) { result = result; }
}
