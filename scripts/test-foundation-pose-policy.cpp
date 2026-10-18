#include "../Source/AIFactoryCopilot/Public/AIFactoryFoundationPosePolicy.h"
#include <iostream>
#include <limits>
#include <vector>
int main()
{
    using AIFactoryFoundationPosePolicy::AllowsScale;
    const std::vector<bool> checks = {
        AllowsScale(1,1,1,0,0,false),
        AllowsScale(1,1,1,1,1,true),
        AllowsScale(.25,1,1,0,1,true),
        AllowsScale(1,.25,1,1,0,true),
        !AllowsScale(.25,1,1,0,1,false),
        !AllowsScale(1,.25,1,1,0,false),
        !AllowsScale(.25,1,1,1,0,true),
        !AllowsScale(1,.25,1,0,1,true),
        !AllowsScale(.25,.25,1,0,0,true),
        !AllowsScale(1,1,.5,0,0,true),
        !AllowsScale(2,1,1,0,0,true),
        !AllowsScale(-.5,1,1,0,0,true),
        !AllowsScale(0,1,1,0,0,true),
        !AllowsScale(.009,1,1,0,0,true),
        AllowsScale(.01,1,1,0,0,true),
        !AllowsScale(std::numeric_limits<double>::quiet_NaN(),1,1,0,0,true),
        !AllowsScale(1,1,1,std::numeric_limits<double>::infinity(),0,true)
    };
    for (std::size_t i=0; i<checks.size(); ++i)
        if (!checks[i]) { std::cerr << "Foundation pose policy failed case " << i << '\n'; return 1; }
    std::cout << checks.size() << " foundation pose policy cases passed\n";
}
