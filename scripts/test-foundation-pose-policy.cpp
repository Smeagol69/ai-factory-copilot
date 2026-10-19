#include "../Source/AIFactoryCopilot/Public/AIFactoryFoundationPosePolicy.h"
#include "../Source/AIFactoryCopilot/Public/AIFactoryFixturePosePolicy.h"
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
    using AIFactoryFixturePosePolicy::AllowsScale;
    const std::vector<bool> fixtures = {
        AllowsScale(.3,.3,.3,0,false), AllowsScale(.05,.05,.05,1,false),
        !AllowsScale(.3,.3,.2,0,false), !AllowsScale(.049,.049,.049,0,false),
        !AllowsScale(2,2,2,0,false), !AllowsScale(-1,-1,-1,0,false),
        AllowsScale(.01,1,1,0,true), AllowsScale(1,1,1,0,true),
        !AllowsScale(.5,.5,1,0,true), !AllowsScale(.5,1,.5,0,true),
        !AllowsScale(.5,1,1,.1,true), !AllowsScale(.009,1,1,0,true),
        !AllowsScale(std::numeric_limits<double>::quiet_NaN(),1,1,0,true)
    };
    for (std::size_t i=0; i<fixtures.size(); ++i)
        if (!fixtures[i]) { std::cerr << "Fixture pose policy failed case " << i << '\n'; return 1; }
    std::cout << checks.size() << " foundation and " << fixtures.size() << " fixture pose policy cases passed\n";
}
